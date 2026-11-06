# Deploying to a server

The whole app runs on one Linux server with Docker, behind HTTPS, and every merge to `main` that
passes CI is deployed automatically. Any Ubuntu 22.04/24.04 server works the same way, x86 or ARM.
It needs 2 GB of memory or more; below 4 GB the setup script adds a 2 GB swap file. This guide shows
AWS (EC2) and Oracle Cloud.

```
browser ──https──► Caddy (certificates) ──► nginx (the web app) ──► backend ──► MongoDB, Redis
                                                                       ▲   │
                                                     AI service ───────┘◄──┘ (inside the server)
                                                         │
                                                         ▼
                                                      Qdrant (department knowledge index)
```

| File | What it is |
|---|---|
| `docker-compose.prod.yml` | the production stack: MongoDB and Redis with passwords, Qdrant with an API key, backend, AI service, web app, Caddy |
| `deploy/Caddyfile` | HTTPS for your domain with a free Let's Encrypt certificate |
| `deploy/setup-server.sh` | prepares a fresh server once |
| `deploy/deploy.sh` | deploys one commit; starts the previous one again if the new one is not healthy |
| `deploy/auto-deploy.sh` | runs on the server every 2 minutes: deploys a new commit of `main` once CI has passed on it |
| `deploy/backup-mongo.sh` | the nightly database backup |
| `deploy/stack-settings.sh` | the settings generated on the server (the Qdrant key), added to `stack.env` by the setup script and by every deploy, never changed once there |

Secrets never go into the repository or GitHub: the setup script generates them on the server, in
`/etc/nsk/`, readable only by the login user. The server pulls new versions itself, so GitHub holds
no key to it and SSH can stay open to your own IP address only.

## 1. What you need

- A domain or subdomain you can add DNS records to, e.g. `hr.example.com`.
- A Groq API key for the AI service (console.groq.com).
- The email address of the first administrator.

## 2. Create the server

On your computer, create an SSH key to log in to the server:

```
ssh-keygen -t ed25519 -f ~/.ssh/nsk_login -C "nsk login"
```

The file without `.pub` is private: never share it or commit it.

### AWS (EC2)

1. In the region nearest your users, **EC2 → Key pairs → Actions → Import key pair**: upload
   `nsk_login.pub`.
2. **EC2 → Security groups → Create security group**, inbound rules: SSH (TCP 22) from your own IP
   only (`<your ip>/32`); HTTP (TCP 80) and HTTPS (TCP 443) from `0.0.0.0/0` and `::/0`.
3. **EC2 → Launch instance**:
   - Image: Ubuntu Server 24.04 LTS (64-bit Arm for `t4g`, x86 for `t3`)
   - Type: `t4g.small` (2 GB) runs the stack with the setup script's swap; `t4g.medium` (4 GB) gives room
     for more people and for indexing knowledge documents (the AI service uses about 300 MB more once
     its embedding model is loaded, Qdrant about 80 MB plus its data)
   - Key pair and security group: the two above
   - Storage: 30 GB gp3, encrypted
   - Advanced details: credit specification **Standard** (`Unlimited`, the default for T types,
     bills extra when the CPU stays busy), metadata **IMDSv2 required**, termination protection on
4. **EC2 → Elastic IPs → Allocate**, then **Associate** it with the instance, so the address
   survives restarts. That address is the server's **public IP**. Log in as `ubuntu`.
5. Set a budget alert (**Billing → Budgets**) so a surprise cost reaches you by email.

### Oracle Cloud (Always Free)

1. Sign up at oracle.com/cloud/free. Pick the home region nearest your users; it cannot be changed.
2. **Compute → Instances → Create instance**:
   - Image: Canonical Ubuntu 24.04
   - Shape: Ampere `VM.Standard.A1.Flex`, 2 OCPUs, 12 GB memory (the free allowance)
   - Networking: a public subnet, with a public IPv4 address
   - SSH keys: paste the contents of `nsk_login.pub`
   - Boot volume: 100 GB

   "Out of capacity" is common; try another availability domain or try again later.
3. Open the web ports: the instance's **Subnet → Default Security List → Add Ingress Rules**:
   source `0.0.0.0/0`, TCP, destination port `80`; and the same for `443`.
4. Note the instance's **public IP address**.

## 3. Point the domain at the server

Add an **A record** at the domain's DNS provider. For `hr.example.com`, that is name `hr`, pointing
to the server's public IP. Check it from your computer with `nslookup hr.example.com`.

## 4. Prepare the server

```
ssh -i ~/.ssh/nsk_login ubuntu@<server ip>
git clone https://github.com/shivakrishna69/mutliple-agents.git /tmp/nsk-setup
sudo bash /tmp/nsk-setup/deploy/setup-server.sh
```

It asks for the domain, an email for certificate notices, the administrator's email, the company
name (optional) and the Groq key (hidden). It installs Docker, adds swap on a server under 4 GB,
opens ports 80 and 443 in the server's firewall, clones the code to `/opt/nsk`, writes the settings
with new random secrets, and installs the nightly backup and the automatic deploys. It can be run
again safely: existing settings are kept.

## 5. First deploy

Once the DNS record points at the server:

```
sudo -u ubuntu /opt/nsk/deploy/deploy.sh main
```

The first build takes several minutes. Set up email first (below): signing up sends a confirmation
link. Then open `https://<your domain>`, sign up with the administrator email and open the link
emailed to it: that account becomes the administrator.

## 6. Deploys on every merge to main

Nothing to set up in GitHub. Every 2 minutes the server (`nsk-deploy` timer) fetches `main`. When
there is a new commit, it asks GitHub whether the **CI** workflow passed on it, and deploys it once
it has; while CI runs it waits, and a commit whose CI failed is not deployed. A merge is usually live
a few minutes after its CI finishes.

```
journalctl -u nsk-deploy -n 50   # what was deployed, waited for or refused, and when
systemctl list-timers nsk-deploy # the next check
```

If a deploy fails, the previous version is started again and that commit is not retried: fix it on
`main` (the next commit is deployed as usual), or deploy a commit by hand with `deploy/deploy.sh`.

The CI result is read from GitHub's public API, which works for a public repository. For a private
one, put a read-only token in `/etc/nsk/auto-deploy.env` as `GITHUB_TOKEN=...` (the server then also
needs read access to clone and fetch the code).

## Running it

All commands on the server, as `ubuntu`, from `/opt/nsk`:

```
alias nsk='docker compose -f /opt/nsk/docker-compose.prod.yml --env-file /etc/nsk/stack.env'
nsk ps                      # what is running, and whether it is healthy
nsk logs -f backend         # follow a service's log (backend, ai-service, qdrant, frontend, caddy, mongo)
nsk restart backend         # restart one service
deploy/deploy.sh main       # deploy the latest main by hand
deploy/deploy.sh <commit>   # go back to an earlier commit of main
```

**Changing settings** (email, Groq key...): edit the file in `/etc/nsk/` (`backend.env`,
`ai-service.env`), then `nsk up -d` to restart with them. `backend/.env.example` and
`ai-service/.env.example` list every setting.

**Department knowledge bases** need nothing to set up: Qdrant runs in the stack, reachable only inside it (no published port), used by
the AI service, with the key `QDRANT_API_KEY` from `/etc/nsk/stack.env`, generated on the server.
A server set up before Qdrant was added gets the key on its next deploy (`deploy/stack-settings.sh`),
except for the first deploy of that version, which the previous `deploy.sh` runs: add the key once
by hand before it, or that deploy fails and the previous version keeps running:

```
grep -q '^QDRANT_API_KEY=' /etc/nsk/stack.env || echo "QDRANT_API_KEY=$(openssl rand -hex 32)" | sudo tee -a /etc/nsk/stack.env >/dev/null
```

**Email** (signup confirmation, password reset, invitations, leave notices): set `SMTP_HOST`,
`SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD` and `MAIL_FROM` in `/etc/nsk/backend.env` (the file has
them, commented out), then `nsk up -d`. Without email, nobody can sign up or reset a password.

### Backups

Every night at 21:00 UTC the database is dumped to `/var/backups/nsk/` and dumps older than 14
days are deleted. `sudo systemctl start nsk-backup` makes one now; `systemctl list-timers nsk-backup`
shows the next run. **Copy them off the server too** (for example, download them regularly with
`scp`): a backup on the same disk is lost with the server.

The knowledge index (Qdrant's `qdrant-data` volume) is not backed up: every chunk can be rebuilt
from the documents, which are in the database. After restoring a backup, or if Qdrant lost its data,
index everything again; the backend reads and indexes the documents within a minute or so each:

```
nsk exec backend node scripts/reindexKnowledge.js            # every department
nsk exec backend node scripts/reindexKnowledge.js <id>       # one department
```

To restore one (this replaces the current data):

```
source <(grep MONGO_ROOT /etc/nsk/stack.env)
nsk exec -T mongo mongorestore --username "$MONGO_ROOT_USERNAME" --password "$MONGO_ROOT_PASSWORD" \
  --authenticationDatabase admin --drop --gzip --archive < /var/backups/nsk/nsk-<date>.archive.gz
```

## When something is wrong

- **The site has no certificate / "connection not private"**: the DNS record must point at the
  server and ports 80 and 443 must be open in the cloud's firewall (step 2). `nsk logs caddy`
  shows what Let's Encrypt answered.
- **A deploy failed**: `journalctl -u nsk-deploy` shows the last lines of every service's log; the
  previous version was started again. `nsk logs <service>` shows more.
- **A merge was not deployed**: `journalctl -u nsk-deploy` says whether it is waiting for CI, CI
  failed, or the deploy failed.
- **The AI service is unhealthy**: the Groq key in `/etc/nsk/ai-service.env` is missing or wrong.
- **Knowledge documents stay waiting or fail with "the knowledge index could not be reached"**:
  `nsk logs ai-service` and `nsk logs qdrant`. Once both are up, re-index the failed ones
  (`nsk exec backend node scripts/reindexKnowledge.js`).
- **A deploy failed with "set QDRANT_API_KEY in the stack settings"**: add the key (see
  Department knowledge bases above) and deploy again.

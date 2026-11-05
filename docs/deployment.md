# Deploying to a server

The whole app runs on one Linux server with Docker, behind HTTPS, and every merge to `main` that
passes CI is deployed automatically. Any Ubuntu 22.04/24.04 server works the same way, x86 or ARM.
It needs 2 GB of memory or more; below 4 GB the setup script adds a 2 GB swap file. This guide shows
AWS (EC2) and Oracle Cloud.

```
browser ──https──► Caddy (certificates) ──► nginx (the web app) ──► backend ──► MongoDB, Redis
                                                                       ▲
                                                     AI service ───────┘ (over https, inside the server)
```

| File | What it is |
|---|---|
| `docker-compose.prod.yml` | the production stack: MongoDB and Redis with passwords, backend, AI service, web app, Caddy |
| `deploy/Caddyfile` | HTTPS for your domain with a free Let's Encrypt certificate |
| `deploy/setup-server.sh` | prepares a fresh server once |
| `deploy/deploy.sh` | deploys one commit; starts the previous one again if the new one is not healthy |
| `deploy/backup-mongo.sh` | the nightly database backup |
| `.github/workflows/deploy.yml` | runs `deploy.sh` on the server after CI passes on `main` |

Secrets never go into the repository or GitHub: the setup script generates them on the server, in
`/etc/nsk/`, readable only by the login user.

## 1. What you need

- A domain or subdomain you can add DNS records to, e.g. `hr.example.com`.
- A Groq API key for the AI service (console.groq.com).
- The email address of the first administrator.

## 2. Create the server

On your computer, create two SSH keys: one for you to log in, one that GitHub uses to deploy.

```
ssh-keygen -t ed25519 -f ~/.ssh/nsk_login  -C "nsk login"
ssh-keygen -t ed25519 -f ~/.ssh/nsk_deploy -C "nsk github deploy" -N ""
```

The files without `.pub` are private: never share them or commit them.

### AWS (EC2)

1. In the region nearest your users, **EC2 → Key pairs → Actions → Import key pair**: upload
   `nsk_login.pub`.
2. **EC2 → Security groups → Create security group**, inbound rules: SSH (TCP 22) from your own IP
   only (`<your ip>/32`); HTTP (TCP 80) and HTTPS (TCP 443) from `0.0.0.0/0` and `::/0`.
3. **EC2 → Launch instance**:
   - Image: Ubuntu Server 24.04 LTS (64-bit Arm for `t4g`, x86 for `t3`)
   - Type: `t4g.small` (2 GB) is enough for a small company; `t4g.medium` (4 GB) for more people
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
name (optional), the Groq key (hidden) and the deploy public key (paste the contents of
`nsk_deploy.pub`). It installs Docker, adds swap on a server under 4 GB, opens ports 80 and 443 in
the server's firewall, clones the
code to `/opt/nsk`, writes the settings with new random secrets, and installs the nightly backup.
It can be run again safely: existing settings are kept.

## 5. First deploy

Once the DNS record points at the server:

```
sudo -u ubuntu /opt/nsk/deploy/deploy.sh main
```

The first build takes several minutes. Then open `https://<your domain>` and sign up with the
administrator email: that account becomes the administrator.

## 6. Deploy on every merge to main

In GitHub: **Settings → Secrets and variables → Actions**.

| Kind | Name | Value |
|---|---|---|
| Secret | `DEPLOY_HOST` | your domain |
| Secret | `DEPLOY_USER` | `ubuntu` |
| Secret | `DEPLOY_SSH_KEY` | the contents of `~/.ssh/nsk_deploy` (the private key) |
| Secret | `DEPLOY_KNOWN_HOSTS` | the line the setup script printed (`<domain> ssh-ed25519 AAAA…`) |
| Variable | `APP_URL` | `https://<your domain>` |
| Variable | `DEPLOY_ENABLED` | `true` |

From then on, each push to `main` runs CI, and when CI passes, **Deploy** runs. It can also be
started by hand: **Actions → Deploy → Run workflow**. The deploy key can only run `deploy.sh`: it
cannot open a shell on the server.

## Running it

All commands on the server, as `ubuntu`, from `/opt/nsk`:

```
alias nsk='docker compose -f /opt/nsk/docker-compose.prod.yml --env-file /etc/nsk/stack.env'
nsk ps                      # what is running, and whether it is healthy
nsk logs -f backend         # follow a service's log (backend, ai-service, frontend, caddy, mongo)
nsk restart backend         # restart one service
deploy/deploy.sh main       # deploy the latest main by hand
deploy/deploy.sh <commit>   # go back to an earlier commit of main
```

**Changing settings** (email, Groq key...): edit the file in `/etc/nsk/` (`backend.env`,
`ai-service.env`), then `nsk up -d` to restart with them. `backend/.env.example` and
`ai-service/.env.example` list every setting.

**Email for invitations**: set `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD` and
`MAIL_FROM` in `/etc/nsk/backend.env` (the file has them, commented out), then `nsk up -d`.

### Backups

Every night at 21:00 UTC the database is dumped to `/var/backups/nsk/` and dumps older than 14
days are deleted. `sudo systemctl start nsk-backup` makes one now; `systemctl list-timers nsk-backup`
shows the next run. **Copy them off the server too** (for example, download them regularly with
`scp`): a backup on the same disk is lost with the server.

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
- **A deploy failed**: the Actions log shows the last lines of every service's log; the previous
  version was started again. On the server, `nsk logs <service>` shows more.
- **The AI service is unhealthy**: the Groq key in `/etc/nsk/ai-service.env` is missing or wrong.

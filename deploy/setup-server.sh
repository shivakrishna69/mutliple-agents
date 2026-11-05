#!/usr/bin/env bash
#
# Prepares a fresh Ubuntu server (22.04 or 24.04, x86 or ARM, e.g. AWS t4g or Oracle Ampere) to run
# the app with docker-compose.prod.yml. Run it once as the login user, with sudo:
#
#   sudo bash setup-server.sh
#
# It asks for the settings below (or takes them from the environment) and is safe to run again:
# existing settings and secrets are never overwritten.
#
#   NSK_DOMAIN             where people open the app, e.g. hr.example.com (its DNS A record must
#                          point at this server before the first deploy, for the HTTPS certificate)
#   NSK_ACME_EMAIL         Let's Encrypt's contact for certificate notices
#   NSK_ADMIN_EMAIL        the account that becomes the first administrator when it signs up
#   NSK_COMPANY_NAME       the company name the installation starts with (optional)
#   NSK_GROQ_API_KEY       the AI service's Groq key (asked without echoing it)
#   NSK_DEPLOY_PUBLIC_KEY  GitHub Actions' public key; it may run deploy/deploy.sh and nothing else
#   NSK_REPO_URL           the repository to deploy (default below)
#   NSK_SWAP_SIZE          swap file size on a server with less than 4 GB of memory (default 2G;
#                          0 skips it)
#
# What it does:
#   1. installs Docker Engine and Compose from Docker's own repository, and on a small server adds a
#      swap file so building the images and running the stack does not run out of memory
#   2. opens ports 80 and 443 in the server's firewall (Oracle's images allow only SSH; on AWS the
#      security group does this, and the script changes nothing)
#   3. clones the repository to /opt/nsk
#   4. writes /etc/nsk/{stack,backend,ai-service}.env with new random secrets, readable only by the
#      login user; nothing secret is stored in the repository or in GitHub
#   5. installs a daily database backup (deploy/backup-mongo.sh, systemd timer nsk-backup)
#   6. lets the deploy key run deploy/deploy.sh only
# Then it prints what to put in GitHub and how to run the first deploy.

set -euo pipefail

readonly APP_DIR=/opt/nsk
readonly CONFIG_DIR=/etc/nsk
readonly DEFAULT_REPO_URL=https://github.com/shivakrishna69/mutliple-agents.git
readonly DEFAULT_SWAP_SIZE=2G
# Below this much memory (in kB) the server gets a swap file.
readonly SWAP_BELOW_MEMORY_KB=$((4 * 1024 * 1024))
readonly SWAP_FILE=/swapfile

say() { printf '\n==> %s\n' "$*"; }
fail() {
  printf 'setup-server: %s\n' "$*" >&2
  exit 1
}

[[ $EUID -eq 0 ]] || fail "run it with sudo: sudo bash setup-server.sh"
DEPLOY_USER="${SUDO_USER:-}"
[[ -n "$DEPLOY_USER" && "$DEPLOY_USER" != root ]] || fail "run it with sudo from the login user (e.g. ubuntu), not as root"
DEPLOY_HOME="$(getent passwd "$DEPLOY_USER" | cut -d: -f6)"
# shellcheck source=/dev/null
. /etc/os-release
[[ "${ID:-}" == ubuntu ]] || fail "this script supports Ubuntu only"

# A setting from the environment, or asked for. $3 = "secret" hides the answer, "optional" allows "".
ask() {
  local variable="$1" question="$2" mode="${3:-}" answer="${!1:-}"
  while [[ -z "$answer" ]]; do
    if [[ "$mode" == secret ]]; then
      read -r -s -p "$question: " answer
      echo
    else
      read -r -p "$question: " answer
    fi
    [[ "$mode" == optional ]] && break
  done
  printf -v "$variable" '%s' "$answer"
}

random_hex() { openssl rand -hex "$1"; }

# --- 1. Docker -----------------------------------------------------------------------------------
say "Installing Docker"
# No package asks questions: the script also runs without a terminal (e.g. over ssh with a command).
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq ca-certificates curl git openssl >/dev/null
if ! docker compose version >/dev/null 2>&1; then
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable" \
    >/etc/apt/sources.list.d/docker.list
  apt-get update -qq
  apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin >/dev/null
fi
systemctl enable --now docker >/dev/null
usermod -aG docker "$DEPLOY_USER"
docker compose version

# Swap: lets a 1-2 GB server build the images and absorb peaks instead of killing a service.
swap_size="${NSK_SWAP_SIZE:-$DEFAULT_SWAP_SIZE}"
memory_kb="$(awk '/^MemTotal:/ { print $2 }' /proc/meminfo)"
if [[ "$swap_size" != 0 && "$memory_kb" -lt "$SWAP_BELOW_MEMORY_KB" ]]; then
  if [[ -n "$(swapon --noheadings --show=NAME)" ]]; then
    echo "swap already on: $(swapon --noheadings --show=NAME,SIZE | tr '\n' ' ')"
  else
    say "Adding a $swap_size swap file ($SWAP_FILE)"
    [[ -e "$SWAP_FILE" ]] || fallocate -l "$swap_size" "$SWAP_FILE"
    chmod 600 "$SWAP_FILE"
    mkswap "$SWAP_FILE" >/dev/null
    swapon "$SWAP_FILE"
    grep -q "^$SWAP_FILE " /etc/fstab || echo "$SWAP_FILE none swap sw 0 0" >>/etc/fstab
    # Use swap only under pressure, so the database stays in memory.
    echo 'vm.swappiness=10' >/etc/sysctl.d/90-nsk-swap.conf
    sysctl -q -p /etc/sysctl.d/90-nsk-swap.conf
  fi
fi

# --- 2. Firewall ---------------------------------------------------------------------------------
say "Opening ports 80 and 443"
# Oracle's Ubuntu images end the INPUT chain with a REJECT rule; the new rules go just before it.
# Ports must also be open in the cloud's own firewall (Oracle: the subnet's security list).
if command -v iptables >/dev/null; then
  for port in 80 443; do
    rule=(-p tcp --dport "$port" -m conntrack --ctstate NEW -j ACCEPT)
    if ! iptables -C INPUT "${rule[@]}" 2>/dev/null; then
      reject_line="$(iptables -L INPUT --line-numbers -n | awk '$2 == "REJECT" { print $1; exit }')"
      if [[ -n "$reject_line" ]]; then
        iptables -I INPUT "$reject_line" "${rule[@]}"
      else
        iptables -A INPUT "${rule[@]}"
      fi
    fi
  done
  # Kept across reboots by adding the same rules to the saved set, before its REJECT. (Saving the
  # live rules instead would also save Docker's own chains, which Docker recreates at start.)
  saved_rules=/etc/iptables/rules.v4
  if [[ -f "$saved_rules" ]] && ! grep -q -- '--dport 443 -j ACCEPT' "$saved_rules"; then
    sed -i '0,/^-A INPUT -j REJECT/s//-A INPUT -p tcp -m state --state NEW -m tcp --dport 80 -j ACCEPT\n-A INPUT -p tcp -m state --state NEW -m tcp --dport 443 -j ACCEPT\n&/' \
      "$saved_rules"
  fi
fi
if command -v ufw >/dev/null && ufw status | grep -q "Status: active"; then
  ufw allow 80/tcp >/dev/null
  ufw allow 443/tcp >/dev/null
fi

# --- 3. Code -------------------------------------------------------------------------------------
say "Getting the code into $APP_DIR"
if [[ ! -d "$APP_DIR/.git" ]]; then
  install -d -o "$DEPLOY_USER" -g "$DEPLOY_USER" "$APP_DIR"
  sudo -u "$DEPLOY_USER" git clone --quiet "${NSK_REPO_URL:-$DEFAULT_REPO_URL}" "$APP_DIR"
fi
chown -R "$DEPLOY_USER:$DEPLOY_USER" "$APP_DIR"

# --- 4. Settings and secrets ---------------------------------------------------------------------
say "Writing settings to $CONFIG_DIR"
install -d -m 750 -o root -g "$DEPLOY_USER" "$CONFIG_DIR"

# Writes a settings file once, readable only by the login user.
write_once() {
  local file="$1" content="$2"
  if [[ -e "$file" ]]; then
    echo "kept $file (already there)"
    return
  fi
  install -m 600 -o "$DEPLOY_USER" -g "$DEPLOY_USER" /dev/null "$file"
  printf '%s\n' "$content" >"$file"
  echo "wrote $file"
}

if [[ ! -e "$CONFIG_DIR/stack.env" ]]; then
  ask NSK_DOMAIN "Domain people will open (e.g. hr.example.com)"
  ask NSK_ACME_EMAIL "Email for HTTPS certificate notices"
fi
write_once "$CONFIG_DIR/stack.env" "# Read by docker compose (docker-compose.prod.yml). Created by deploy/setup-server.sh.
APP_DOMAIN=${NSK_DOMAIN:-}
ACME_EMAIL=${NSK_ACME_EMAIL:-}
MONGO_ROOT_USERNAME=nsk
MONGO_ROOT_PASSWORD=$(random_hex 24)
REDIS_PASSWORD=$(random_hex 24)"

ai_service_api_key="$(random_hex 32)"
if [[ ! -e "$CONFIG_DIR/backend.env" ]]; then
  ask NSK_ADMIN_EMAIL "Email of the first administrator (they sign up with it)"
  ask NSK_COMPANY_NAME "Company name (Enter to set it later in the app)" optional
fi
write_once "$CONFIG_DIR/backend.env" "# The backend's settings (backend/.env.example lists them all). Created by deploy/setup-server.sh.
# Addresses, NODE_ENV and the database and Redis URLs come from docker-compose.prod.yml.
JWT_SECRET=$(random_hex 64)
WEBHOOK_SIGNING_SECRET=$(random_hex 64)
AI_SERVICE_API_KEY=$ai_service_api_key
BOOTSTRAP_ADMIN_EMAIL=${NSK_ADMIN_EMAIL:-}
COMPANY_NAME=${NSK_COMPANY_NAME:-}
LOG_LEVEL=info

# Email for invitations. Without SMTP_HOST, HR is shown the links to share instead.
# SMTP_HOST=smtp.example.com
# SMTP_PORT=465
# SMTP_USER=hr@example.com
# SMTP_PASSWORD=
# MAIL_FROM=\"Company HR <hr@example.com>\""

if [[ ! -e "$CONFIG_DIR/ai-service.env" ]]; then
  ask NSK_GROQ_API_KEY "Groq API key for the AI service (input hidden)" secret
  # The two services must share one key; reuse the backend's when its file already existed.
  ai_service_api_key="$(sed -n 's/^AI_SERVICE_API_KEY=//p' "$CONFIG_DIR/backend.env" | tail -n 1)"
fi
write_once "$CONFIG_DIR/ai-service.env" "# The AI service's settings (ai-service/.env.example lists them all). Created by deploy/setup-server.sh.
AI_SERVICE_API_KEY=$ai_service_api_key
GROQ_API_KEY=${NSK_GROQ_API_KEY:-}
LOG_LEVEL=INFO"

# --- 5. Backups ----------------------------------------------------------------------------------
say "Installing the daily database backup"
cat >/etc/systemd/system/nsk-backup.service <<UNIT
[Unit]
Description=Back up the NSK database
Requires=docker.service
After=docker.service

[Service]
Type=oneshot
ExecStart=/usr/bin/env bash $APP_DIR/deploy/backup-mongo.sh
UNIT
cat >/etc/systemd/system/nsk-backup.timer <<UNIT
[Unit]
Description=Back up the NSK database every night

[Timer]
# 21:00 UTC is 02:30 in India.
OnCalendar=*-*-* 21:00:00 UTC
Persistent=true

[Install]
WantedBy=timers.target
UNIT
systemctl daemon-reload
systemctl enable --now nsk-backup.timer >/dev/null

# --- 6. Deploy key -------------------------------------------------------------------------------
say "Allowing GitHub Actions to deploy"
ask NSK_DEPLOY_PUBLIC_KEY "GitHub deploy public key (ssh-ed25519 ..., Enter to skip)" optional
if [[ -n "${NSK_DEPLOY_PUBLIC_KEY:-}" ]]; then
  [[ "$NSK_DEPLOY_PUBLIC_KEY" =~ ^ssh-ed25519\ [A-Za-z0-9+/=]+ ]] || fail "that is not an ssh-ed25519 public key"
  key_body="$(awk '{ print $2 }' <<<"$NSK_DEPLOY_PUBLIC_KEY")"
  authorized_keys="$DEPLOY_HOME/.ssh/authorized_keys"
  install -d -m 700 -o "$DEPLOY_USER" -g "$DEPLOY_USER" "$DEPLOY_HOME/.ssh"
  touch "$authorized_keys"
  if ! grep -qF "$key_body" "$authorized_keys"; then
    # "restrict" turns off forwarding and terminals; the key can only run the deploy script.
    echo "restrict,command=\"$APP_DIR/deploy/deploy.sh\" $NSK_DEPLOY_PUBLIC_KEY" >>"$authorized_keys"
  fi
  chown "$DEPLOY_USER:$DEPLOY_USER" "$authorized_keys"
  chmod 600 "$authorized_keys"
  echo "deploy key installed for $DEPLOY_USER"
fi

# --- Next steps ----------------------------------------------------------------------------------
domain="$(sed -n 's/^APP_DOMAIN=//p' "$CONFIG_DIR/stack.env" | tail -n 1)"
cat <<NEXT

Setup finished. Next:

1. Point the DNS A record of $domain at this server, then run the first deploy:
     sudo -u $DEPLOY_USER $APP_DIR/deploy/deploy.sh main

2. In GitHub, Settings -> Secrets and variables -> Actions, for deploys on every merge to main:
     Secrets:
       DEPLOY_HOST         $domain
       DEPLOY_USER         $DEPLOY_USER
       DEPLOY_SSH_KEY      the private half of the deploy key (from your computer)
       DEPLOY_KNOWN_HOSTS  $domain $(awk '{ print $1, $2 }' /etc/ssh/ssh_host_ed25519_key.pub)
     Variables:
       APP_URL             https://$domain
       DEPLOY_ENABLED      true

3. Open https://$domain and sign up with the administrator email.
NEXT

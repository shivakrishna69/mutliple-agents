#!/usr/bin/env bash
#
# Writes a compressed dump of the app's database to /var/backups/nsk and deletes dumps older than
# KEEP_DAYS. Run daily by the nsk-backup systemd timer (installed by deploy/setup-server.sh); it can
# also be run by hand. Restore one with (see docs/deployment.md):
#
#   docker compose ... exec -T mongo mongorestore --username ... --authenticationDatabase admin \
#     --drop --gzip --archive < /var/backups/nsk/nsk-<date>.archive.gz
#
# The dumps stay on this server's disk: copy them elsewhere too, or a lost server loses them.

set -euo pipefail

readonly APP_DIR="${NSK_APP_DIR:-/opt/nsk}"
readonly STACK_ENV_FILE="${NSK_STACK_ENV_FILE:-/etc/nsk/stack.env}"
readonly BACKUP_DIR="${NSK_BACKUP_DIR:-/var/backups/nsk}"
readonly KEEP_DAYS="${NSK_BACKUP_KEEP_DAYS:-14}"

# One setting from the stack file, read without running the file as a script.
setting() { sed -n "s/^$1=//p" "$STACK_ENV_FILE" | tail -n 1; }

username="$(setting MONGO_ROOT_USERNAME)"
password="$(setting MONGO_ROOT_PASSWORD)"
[[ -n "$username" && -n "$password" ]] || {
  echo "MONGO_ROOT_USERNAME and MONGO_ROOT_PASSWORD must be set in $STACK_ENV_FILE" >&2
  exit 1
}

install -d -m 700 "$BACKUP_DIR"
target="$BACKUP_DIR/nsk-$(date -u +%Y-%m-%dT%H%M%SZ).archive.gz"

# Written under a temporary name, so a failed dump never looks like a good one.
docker compose --project-directory "$APP_DIR" --file "$APP_DIR/docker-compose.prod.yml" \
  --env-file "$STACK_ENV_FILE" exec -T mongo \
  mongodump --quiet --username "$username" --password "$password" --authenticationDatabase admin \
  --db nsk --gzip --archive >"$target.partial"
mv "$target.partial" "$target"
chmod 600 "$target"

find "$BACKUP_DIR" -name 'nsk-*.archive.gz' -mtime "+$KEEP_DAYS" -delete
echo "backup written: $target ($(du -h "$target" | cut -f1))"

#!/usr/bin/env bash
#
# Deploys one commit of main on this server: checks it out, rebuilds the images and restarts the
# stack (docker-compose.prod.yml), waiting until every service is healthy. If the new version does
# not come up healthy, the previous commit is started again and the deploy fails.
#
#   deploy/deploy.sh <40-character commit id>    a commit that is on origin/main
#   deploy/deploy.sh main                        the latest origin/main
#
# deploy/auto-deploy.sh runs it for each new commit of main that passed CI; run it by hand to deploy
# or go back to a particular commit. Only one deploy runs at a time.
#
# Everything runs inside main(), defined before anything runs: the checkout below replaces this very
# file, and bash would otherwise read the rest of it from the new version.

set -euo pipefail

readonly APP_DIR="${NSK_APP_DIR:-/opt/nsk}"
readonly STACK_ENV_FILE="${NSK_STACK_ENV_FILE:-/etc/nsk/stack.env}"
readonly WAIT_SECONDS=600

log() { printf '[deploy %s] %s\n' "$(date -u +%H:%M:%S)" "$*"; }
fail() {
  log "$*"
  exit 1
}

compose() {
  docker compose --project-directory "$APP_DIR" --file "$APP_DIR/docker-compose.prod.yml" \
    --env-file "$STACK_ENV_FILE" "$@"
}

start_stack() {
  compose up --detach --build --remove-orphans --wait --wait-timeout "$WAIT_SECONDS"
}

main() {
  local requested="${1:-}"
  [[ -n "$requested" ]] || fail "usage: deploy.sh <commit id> | main"

  exec 9>"$APP_DIR/.deploy.lock"
  flock --wait 900 9 || fail "another deploy is still running"

  cd "$APP_DIR"
  git fetch --quiet origin main
  local target
  if [[ "$requested" == "main" ]]; then
    target="$(git rev-parse origin/main)"
  elif [[ "$requested" =~ ^[0-9a-f]{40}$ ]]; then
    target="$requested"
    git merge-base --is-ancestor "$target" origin/main 2>/dev/null || fail "$target is not on main; refusing to deploy it"
  else
    fail "expected a 40-character commit id or \"main\", got: $requested"
  fi

  local previous
  previous="$(git rev-parse HEAD)"
  log "deploying ${target:0:12} (running ${previous:0:12})"
  git checkout --quiet --force --detach "$target"
  # Settings this release generates on the server (the Qdrant key...), from the version just checked
  # out, so a release that needs a new one brings it along. Existing values are never changed.
  # shellcheck source=deploy/stack-settings.sh
  source "$APP_DIR/deploy/stack-settings.sh"
  ensure_generated_stack_settings "$STACK_ENV_FILE"

  if ! start_stack; then
    log "the new version did not become healthy; recent logs:"
    compose logs --tail 60 || true
    if [[ "$previous" != "$target" ]]; then
      log "starting the previous version ${previous:0:12} again"
      git checkout --quiet --force --detach "$previous"
      start_stack || log "the previous version did not become healthy either; check the server"
    fi
    fail "deploy of ${target:0:12} failed"
  fi

  # Old images and build cache would fill the disk over many deploys; a week of cache keeps rebuilds fast.
  docker image prune --force >/dev/null
  docker builder prune --force --filter until=168h >/dev/null
  log "deployed ${target:0:12}"
}

# One line: bash reads it whole, so nothing after it is read from the replaced file.
main "$@"; exit

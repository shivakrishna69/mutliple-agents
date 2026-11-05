#!/usr/bin/env bash
#
# Deploys new commits of main once CI has passed on them. The server pulls: nothing outside needs
# access to it, and GitHub holds no key to it. A systemd timer (nsk-deploy, set up by
# deploy/setup-server.sh) runs this every few minutes as the login user:
#
#   1. fetches origin/main; nothing to do when it is the running commit
#   2. asks GitHub for the CI workflow's result on that commit (one API call, only while a new commit
#      waits): still running or failed -> asked again next time (a re-run that passes is deployed)
#   3. passed -> deploy/deploy.sh <commit>, which starts the previous version again if the new one is
#      not healthy; a commit whose deploy failed is not tried again (deploy it by hand once fixed)
#
# The result is in the journal: journalctl -u nsk-deploy
#
# Settings (environment, optionally from /etc/nsk/auto-deploy.env):
#   NSK_CI_WORKFLOW   the CI workflow file whose result gates a deploy (default ci.yml)
#   GITHUB_TOKEN      a read-only token, needed only if the repository is private

set -euo pipefail

readonly APP_DIR="${NSK_APP_DIR:-/opt/nsk}"
readonly CI_WORKFLOW="${NSK_CI_WORKFLOW:-ci.yml}"
readonly FAILED_MARKER="$APP_DIR/.deploy-failed"
readonly GITHUB_API=https://api.github.com

log() { printf '[auto-deploy] %s\n' "$*"; }

# owner/repo from the checkout's origin (https or ssh form).
repository_slug() {
  local url
  url="$(git -C "$APP_DIR" remote get-url origin)"
  url="${url%.git}"
  url="${url#*github.com[:/]}"
  printf '%s' "$url"
}

# The CI result for a commit pushed to main: success, failure (any other conclusion), or pending.
ci_result() {
  local commit="$1" response
  local auth=()
  [[ -n "${GITHUB_TOKEN:-}" ]] && auth=(-H "Authorization: Bearer $GITHUB_TOKEN")
  response="$(curl --fail --silent --show-error --max-time 20 "${auth[@]}" \
    -H "Accept: application/vnd.github+json" \
    "$GITHUB_API/repos/$(repository_slug)/actions/workflows/$CI_WORKFLOW/runs?head_sha=$commit&event=push&per_page=5")"
  jq -r '
    [.workflow_runs[] | select(.head_branch == "main")] as $runs
    | if any($runs[]; .conclusion == "success") then "success"
      elif ($runs | length) > 0 and all($runs[]; .status == "completed") then "failure"
      else "pending" end' <<<"$response"
}

main() {
  cd "$APP_DIR"
  git fetch --quiet origin main
  local target running
  target="$(git rev-parse origin/main)"
  running="$(git rev-parse HEAD)"
  [[ "$target" == "$running" ]] && return 0
  if [[ -f "$FAILED_MARKER" && "$(cat "$FAILED_MARKER")" == "$target" ]]; then
    return 0
  fi

  local result
  result="$(ci_result "$target")"
  case "$result" in
    pending)
      log "${target:0:12} is waiting for CI"
      return 0
      ;;
    failure)
      # Not remembered: if CI is re-run on this commit and passes, it is deployed then.
      log "CI did not pass on ${target:0:12}; not deploying it"
      return 0
      ;;
  esac

  log "CI passed on ${target:0:12}; deploying"
  if "$APP_DIR/deploy/deploy.sh" "$target"; then
    rm -f "$FAILED_MARKER"
  else
    printf '%s\n' "$target" >"$FAILED_MARKER"
    log "deploy of ${target:0:12} failed; it will not be retried (deploy/deploy.sh <commit> by hand)"
    return 1
  fi
}

# One line: deploy.sh checks out the new commit, which replaces this file while it runs; bash reads
# this line whole, so nothing after it is read from the new version.
main "$@"; exit

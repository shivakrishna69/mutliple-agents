#!/usr/bin/env bash
#
# Settings of /etc/nsk/stack.env that are generated on the server rather than asked for, shared by
# deploy/setup-server.sh (a new server) and deploy/deploy.sh (every deploy), so a server set up before
# a setting existed gets it on its next deploy. Values are random and never overwritten.
#
#   source deploy/stack-settings.sh
#   ensure_generated_stack_settings /etc/nsk/stack.env

# Adds "NAME=value" to a settings file that has no NAME yet; never changes an existing value.
add_missing_setting() {
  local file="$1" name="$2" value="$3"
  if grep -q "^${name}=" "$file"; then
    return
  fi
  printf '%s=%s\n' "$name" "$value" >>"$file"
  echo "added $name to $file"
}

ensure_generated_stack_settings() {
  local file="$1"
  # The key the AI service uses for Qdrant (docker-compose.prod.yml).
  add_missing_setting "$file" QDRANT_API_KEY "$(openssl rand -hex 32)"
}

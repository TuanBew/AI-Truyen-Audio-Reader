#!/usr/bin/env bash
# Creates the LOCAL-ONLY dev user dev@audiotruyen.test (password: local-dev-password) in the
# local Supabase Auth, email confirmed. Idempotent. Refuses to run against anything but localhost.
# Usage (Git Bash, repo root):  bash scripts/local-dev-user.sh
set -euo pipefail

EMAIL="dev@audiotruyen.test"
PASSWORD="local-dev-password"

eval "$(npx --yes supabase@2.121.0 status -o env 2>/dev/null)"
: "${API_URL:?local Supabase is not running (supabase start)}"
: "${SERVICE_ROLE_KEY:?missing SERVICE_ROLE_KEY from supabase status}"

host="${API_URL#*://}"
host="${host%%/*}"
host="${host%%:*}"
if [ "$host" != "127.0.0.1" ] && [ "$host" != "localhost" ]; then
  echo "Refusing to run: API_URL host '$host' is not 127.0.0.1 or localhost." >&2
  exit 1
fi

body="$(printf '{"email":"%s","password":"%s","email_confirm":true}' "$EMAIL" "$PASSWORD")"
out="$(mktemp)"
hdr="$(mktemp)"
trap 'rm -f "$out" "$hdr"' EXIT
# The key goes through a header file, not the command line (process lists keep arguments).
printf 'apikey: %s
Authorization: Bearer %s
' "$SERVICE_ROLE_KEY" "$SERVICE_ROLE_KEY" > "$hdr"

status="$(curl -sS -o "$out" -w '%{http_code}' -X POST "$API_URL/auth/v1/admin/users"   -H 'Content-Type: application/json' -H @"$hdr" -d "$body")"

if [ "$status" = "200" ] || [ "$status" = "201" ]; then
  echo "Created local dev user $EMAIL."
elif grep -qiE 'already (been )?registered|email_exists' "$out"; then
  echo "Local dev user $EMAIL already exists."
else
  echo "Failed to create the local dev user (HTTP $status)." >&2
  exit 1
fi
echo "Sign in at http://localhost:3000/login with $EMAIL (local-only test credential)."

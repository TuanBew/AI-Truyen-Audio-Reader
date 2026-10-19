#!/usr/bin/env bash
# Prints TEST_SUPABASE_* lines for the running local Supabase.
# Usage (Git Bash, repo root):  set -a; source <(bash scripts/supabase-test-env.sh); set +a
# CI:                            bash scripts/supabase-test-env.sh >> "$GITHUB_ENV"
set -euo pipefail
eval "$(npx --yes supabase@2.121.0 status -o env 2>/dev/null)"
echo "TEST_SUPABASE_URL=${API_URL}"
echo "TEST_SUPABASE_ANON_KEY=${ANON_KEY}"
echo "TEST_SUPABASE_SERVICE_ROLE_KEY=${SERVICE_ROLE_KEY}"

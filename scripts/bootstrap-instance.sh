#!/usr/bin/env bash
# From nothing to a demo-ready Synthigy: a SQLite instance in .synthigy/, a
# superuser, one OAuth client per demo (ids and secrets match each demo's own
# .synthigy/.env), and the demo origins on the "Synthigy Tools" client.
#
#   ./scripts/bootstrap-instance.sh [--wipe]
set -euo pipefail

cd "$(dirname "$0")/.."
VERSION="${SYNTHIGY_VERSION:-latest}"
PORT="${SYNTHIGY_SERVER_PORT:-7887}"

synthigy down 2>/dev/null || true
if [ "${1:-}" = "--wipe" ]; then
  for f in synthigy audit logs; do
    rm -f ".synthigy/db/$f.db" ".synthigy/db/$f.db-wal" ".synthigy/db/$f.db-shm"
  done
  echo "database, audit and logs wiped"
fi

synthigy up --bundle sqlite --version "$VERSION"
until curl -sf -o /dev/null --max-time 2 "http://localhost:$PORT/oauth/jwks"; do sleep 2; done
echo "engine ready on :$PORT"

synthigy exec -- java "@.synthigy/launch.args" clojure.main -m synthigy.ops \
  superuser add "${DEMO_USER:-admin}" "${DEMO_PASSWORD:-admin}" 2>/dev/null | tail -1

# client <name> <id> <secret> [port] — a port adds browser login on it.
client() {
  local login=()
  [ -n "${4:-}" ] && login=(--grant authorization_code --grant refresh_token
                            --redirect "http://localhost:$4/auth/callback")
  synthigy iam add-client "$1" --id "$2" --type confidential --secret "$3" \
    --grant client_credentials "${login[@]}" \
    --role SUPERUSER --api Synthigy --trusted --local
}

client "RLS Demo BFF"        rls-demo-bff   rlsbff-secret
client "chat-bff"            chat-bff       chatbff-secret
client "Movies (Go)"         movies-go      moviesgo-secret
client "Movies (PHP)"        movies-php     moviesphp-secret
client "Movies (JS)"         movies-js      movies-secret 5174
client "Datastar Music Demo" datastar-music music-secret  5175

./scripts/add-tools-redirect.sh http://localhost:5174 http://localhost:5175 http://localhost:5176 http://localhost:5177

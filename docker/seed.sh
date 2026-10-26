#!/usr/bin/env bash
# Build time, once: start the engine, give it the demo account and every
# example's client, seed the examples, generate their typed ops and build the
# Go BFF. The engine's database is then kept as docker/snapshot, which every
# container copies on start, so each one begins in the same fresh state.
set -euo pipefail
cd /app
python3 -c 'import base64, secrets; print("b64:" + base64.b64encode(secrets.token_bytes(32)).decode())' > docker/engine.key
. docker/lib.sh

rm -rf "$SYNTHIGY_HOME" docker/snapshot && mkdir -p "$SYNTHIGY_HOME"
engine_start

ops superuser add "${DEMO_USER:-admin}" "${DEMO_PASSWORD:-admin}" | tail -1
# The engine's sign-in page, with the demo account written on it.
bash scripts/add-login-page.sh

# client <name> <id> <secret> [browser] — the same clients bootstrap-instance.sh
# makes. "browser" adds the sign-in grants; start.sh sets the redirect URIs,
# which depend on the public host.
client() {
  local login=()
  [ "${4:-}" = browser ] && login=(--grant authorization_code --grant refresh_token)
  ops iam add-client "$1" "$2" confidential --secret "$3" --api Synthigy \
    --grant client_credentials "${login[@]}" --trusted SUPERUSER | tail -1
}
client "Project Management BFF" project-management-bff pmbff-secret
client "chat-bff"               chat-bff               chatbff-secret
client "Movies (JS)"            movies-js              movies-secret browser
client "Datastar Music Demo"    datastar-music         music-secret  browser

# Project Management first: its cast (Alice, Bob, Charlie, Diana) is the one
# chat reuses.
in_port project-management/go go run ./setup
in_port project-management/go go generate ./...
in_port project-management/go go build -o /app/bin/project-management .

in_port chat/clj bb setup
in_port chat/clj bb gen

in_port music/py .venv/bin/python -c 'import os, synthigy; print(synthigy.connect(os.environ["SYNTHIGY_ENDPOINT"], client_id=os.environ["SYNTHIGY_CLIENT_ID"], client_secret=os.environ["SYNTHIGY_CLIENT_SECRET"]).deploy(open("../../datasets/music/Music Demo@0.1.3.json", encoding="utf-8").read()))'
in_port music/py .venv/bin/python seed.py
in_port music/py .venv/bin/python -m synthigy.codegen gen ../xsql --out generated/music_gen.py --pull
in_port music/py .venv/bin/python brand.py

# Movies starts empty: its guide deploys the model and imports the data in
# front of the visitor. Its typed ops need the model once, so deploy, generate,
# and take it down again.
in_port movies/js npm run setup
in_port movies/js npm run codegen:pull
in_port movies/js npm run teardown

engine_stop
cp -r "$SYNTHIGY_HOME/db" docker/snapshot
rm -rf "$SYNTHIGY_HOME"
echo "seeded; snapshot in docker/snapshot ($(du -sh docker/snapshot | cut -f1))"

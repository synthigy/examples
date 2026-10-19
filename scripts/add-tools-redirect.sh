#!/usr/bin/env bash
# Add one or more origins to the "Synthigy Tools" client's redirect list, so
# @synthigy/tooling's own OIDC login (the tools rail in every demo — see
# examples/shared/README.md) works from a demo's own port. The client ships
# with only localhost:8000/8080/3000 and synthigy.com registered
# (core/resources/exports/app_synthigy_tools.json).
#
# Talks to the portal daemon's own RPC (/rpc/tools.info,
# /rpc/tools.redirections.set), the same calls the setup wizard makes.
#
#   ./scripts/add-tools-redirect.sh http://localhost:5174 http://localhost:5176
#
# Idempotent — merges into whatever is already registered, in both the
# login and logout redirect lists.
set -euo pipefail

if [ "$#" -eq 0 ]; then
  echo "usage: $0 <origin> [origin...]" >&2
  exit 1
fi

cd "$(dirname "$0")/.."
PORTAL_PORT=$(cat .synthigy/portal.port 2>/dev/null || echo "")
if [ -z "$PORTAL_PORT" ]; then
  echo "no .synthigy/portal.port — is the instance up? (bootstrap-instance.sh)" >&2
  exit 1
fi
RPC="http://127.0.0.1:$PORTAL_PORT/rpc"

# python3 where it works, else python: on Windows `python3` is often the
# Microsoft Store alias, which exists on PATH but only prints an install hint.
PY=$(for p in python3 python; do "$p" -c '' >/dev/null 2>&1 && { echo "$p"; break; }; done)
[ -n "$PY" ] || { echo "needs Python 3 (python3 or python on PATH)" >&2; exit 1; }

info=$(curl -sf -X POST "$RPC/tools.info")

merged=$("$PY" - "$info" "$@" <<'EOF'
import json, sys
info = json.loads(sys.argv[1])
origins = sys.argv[2:]
redirections = list(info.get("redirections") or [])
logout = list(info.get("logout_redirections") or [])
for o in origins:
    if o not in redirections:
        redirections.append(o)
    if o not in logout:
        logout.append(o)
print(json.dumps({"redirections": redirections, "logout_redirections": logout}))
EOF
)

curl -sf -X POST "$RPC/tools.redirections.set" \
  -H 'Content-Type: application/json' \
  --data "$merged"
echo
echo "Synthigy Tools client now redirects to: $*"

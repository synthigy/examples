#!/usr/bin/env bash
# Serve shared/login-page as this instance's `default` login page, so the
# engine's own sign-in page names the demo account. The web components send
# visitors there and must not carry demo text themselves.
#
# Talks to the engine console's HTTP endpoints — the same upload + activate
# its System → Login pages screen does. A fresh console session skips the
# password re-check that activation otherwise asks for.
#
#   ./scripts/add-login-page.sh
#
# DEMO_USER/DEMO_PASSWORD (default admin/admin) sign in AND fill the page.
# Every run stores a new version and serves it.
set -euo pipefail

cd "$(dirname "$0")/.."
PORT="${SYNTHIGY_SERVER_PORT:-$(sed -n 's/^SYNTHIGY_SERVER_PORT=//p' .synthigy/.env 2>/dev/null)}"
ENGINE="http://localhost:${PORT:-7887}"
USER_NAME="${DEMO_USER:-admin}"
USER_PASSWORD="${DEMO_PASSWORD:-admin}"
NAME="${LOGIN_PAGE_NAME:-default}"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

python3 - shared/login-page "$tmp/page.zip" "$USER_NAME" "$USER_PASSWORD" <<'EOF'
import pathlib, sys, zipfile
src, out, user, password = sys.argv[1:]
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
    for f in sorted(pathlib.Path(src).iterdir()):
        text = f.read_text().replace("{{DEMO_USER}}", user).replace("{{DEMO_PASSWORD}}", password)
        z.writestr(f.name, text)
EOF

curl -sf -o /dev/null -c "$tmp/cookies" \
  --data-urlencode "username=$USER_NAME" --data-urlencode "password=$USER_PASSWORD" \
  "$ENGINE/console/login"

landed=$(curl -sf -o /dev/null -w '%{redirect_url}' -b "$tmp/cookies" \
  -H 'Content-Type: application/zip' --data-binary @"$tmp/page.zip" \
  "$ENGINE/console/login-pages/upload?name=$NAME")
version=$(sed -n 's/.*[?&]version=\([0-9][0-9]*\).*/\1/p' <<<"$landed")
[ -n "$version" ] || { echo "upload failed: ${landed:-no redirect — wrong login?}" >&2; exit 1; }

landed=$(curl -sf -o /dev/null -w '%{redirect_url}' -b "$tmp/cookies" -X POST \
  "$ENGINE/console/login-pages/activate?name=$NAME&version=$version")
case "$landed" in
  *activated=1*) echo "login page \"$NAME\" v$version served at $ENGINE/login/$NAME/" ;;
  *) echo "activate failed: ${landed:-no redirect}" >&2; exit 1 ;;
esac

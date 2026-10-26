#!/usr/bin/env bash
# Every container start: a fresh copy of the seeded database, the engine, every
# example, the landing page, and Caddy in front routing by host name.
#
#   PUBLIC_HOST   the host visitors use, with port if any   (localhost:8080)
#   PUBLIC_SCHEME http, or https behind a TLS proxy          (http)
#   HOST_PATTERN  each app's host from {app} and {host}      ({app}.{host})
#                 e.g. "{app}-{host}" for one wildcard cert on the sandbox
set -euo pipefail
cd /app
. docker/lib.sh

host_for() { local h=${HOST_PATTERN//\{app\}/$1}; echo "${h//\{host\}/$PUBLIC_HOST}"; }
url_for()  { echo "$PUBLIC_SCHEME://$(host_for "$1")"; }
LANDING="$PUBLIC_SCHEME://$PUBLIC_HOST"
MOVIES=$(url_for movies); CHAT=$(url_for chat); PROJECTS=$(url_for projects)
MUSIC=$(url_for music); ENGINE_PUBLIC=$(url_for engine); CONSOLE=$(url_for console)

# Fresh state: the build's snapshot, copied anew on every start.
rm -rf "$SYNTHIGY_HOME" && mkdir -p "$SYNTHIGY_HOME" && cp -r docker/snapshot "$SYNTHIGY_HOME/db"
engine_start

# The redirect URIs and origins the OAuth clients accept follow the public host.
in_port music/py .venv/bin/python /app/docker/urls.py \
  --movies "$MOVIES" --music "$MUSIC" --apps "$MOVIES" "$CHAT" "$PROJECTS" "$MUSIC" \
  --engine "$ENGINE_PUBLIC" --console "$CONSOLE"

# Each example: its committed .env (client id and secret, internal engine
# address), plus where the browser reaches it, the engine and this page.
app() {
  local name=$1 dir=$2 port=$3 public=$4; shift 4
  ( cd "/app/$dir" && set -a && . ./.synthigy/.env && set +a &&
    PORT=$port BASE_URL=$public SYNTHIGY_PUBLIC_ENDPOINT=$ENGINE_PUBLIC EXAMPLES_URL=$LANDING \
    exec "$@" ) > >(sed -u "s/^/[$name] /" | tee "$LOGS/$name.log") 2>&1 &
}
app movies   movies/js            5174 "$MOVIES"   node serve.ts
app music    music/py             5175 "$MUSIC"    .venv/bin/uvicorn serve:app --host 127.0.0.1 --port 5175
app projects project-management/go 5176 "$PROJECTS" /app/bin/project-management
app chat     chat/clj             5177 "$CHAT"     bb serve

# The landing page, its links pointed at this container's hosts.
mkdir -p /srv/landing
sed -e "s#http://localhost:5174/#$MOVIES/#g" -e "s#http://localhost:5177/#$CHAT/#g" \
    -e "s#http://localhost:5176/#$PROJECTS/#g" -e "s#http://localhost:5175/#$MUSIC/#g" \
    -e "s#http://localhost:7887/console#$CONSOLE/console#g" \
    landing/index.html > /srv/landing/index.html
cp shared/theme.css shared/chrome.js /srv/landing/
cp music/brand/logo.svg /srv/landing/groove-harbor.svg

# Caddy: one listener, routed by host name (the port is ignored), SSE unbuffered.
bare() { local h=$1; h=${h#*://}; echo "${h%%:*}"; }
proxy() { printf '\t@%s host %s\n\thandle @%s {\n\t\treverse_proxy 127.0.0.1:%s {\n\t\t\tflush_interval -1\n\t\t}\n\t}\n' "$1" "$(bare "$2")" "$1" "$3"; }
{
  printf '{\n\tadmin off\n\tauto_https off\n\tservers {\n\t\ttrusted_proxies static private_ranges\n\t}\n}\n\n:80 {\n'
  printf '\t@landing host %s\n\thandle @landing {\n\t\troot * /srv/landing\n\t\tfile_server\n\t}\n' "$(bare "$LANDING")"
  proxy movies   "$MOVIES"   5174
  proxy music    "$MUSIC"    5175
  proxy projects "$PROJECTS" 5176
  proxy chat     "$CHAT"     5177
  proxy engine   "$ENGINE_PUBLIC" 7887
  printf '\t@console host %s\n\thandle @console {\n\t\tredir / /console\n\t\treverse_proxy 127.0.0.1:7887\n\t}\n' "$(bare "$CONSOLE")"
  printf '\thandle {\n\t\trespond "No example lives at this host. Open %s" 404\n\t}\n}\n' "$LANDING"
} > /etc/Caddyfile
caddy run --config /etc/Caddyfile --adapter caddyfile > >(sed -u "s/^/[caddy] /") 2>&1 &

cat <<EOF

  Synthigy examples
    landing   $LANDING
    movies    $MOVIES
    chat      $CHAT
    projects  $PROJECTS
    music     $MUSIC
    console   $CONSOLE/console      (admin / admin)
    engine    $ENGINE_PUBLIC

EOF
# One process down takes the container down: the slot gets replaced, not limped.
wait -n
echo "a process exited; stopping" >&2
exit 1

# Shared by seed.sh (build time) and start.sh (every container start).
# The engine runs straight from its release jar: the `synthigy` CLI is not in
# the image, so this does what `synthigy up` and `synthigy exec` do locally.

ENGINE_JAR=/opt/synthigy/synthigy.jar
ENGINE=http://localhost:${SYNTHIGY_SERVER_PORT:-7887}
LOGS=/var/log/examples
mkdir -p "$LOGS"

# The key the engine encrypts secrets with: made once at build time and kept
# in the image, because the snapshot's encrypted values only open with it.
export SYNTHIGY_ENCRYPTION_MASTER_KEY
SYNTHIGY_ENCRYPTION_MASTER_KEY=$(cat /app/docker/engine.key 2>/dev/null || true)

# Every module the jar registers, set up (first run creates the database) and
# started. Not synthigy.supervisor/serve!, what the CLI runs: that one waits
# for the CLI's portal to drive it over stdio. :synthigy/bare-server is the
# data-only profile, which refuses to run beside the full server.
ENGINE_BOOT="(require 'patcho.lifecycle 'synthigy.server 'synthigy.server.console)
(def modules (remove #{:synthigy/bare-server} (patcho.lifecycle/registered-modules)))
(doseq [m modules] (patcho.lifecycle/setup! m))
(doseq [m modules] (patcho.lifecycle/start! m))
@(promise)"

engine_start() {
  # shellcheck disable=SC2086
  java ${SYNTHIGY_JAVA_OPTS:--Xmx768m} -Dfile.encoding=UTF-8 -cp "$ENGINE_JAR" clojure.main -e "$ENGINE_BOOT" \
    > "$LOGS/engine.log" 2>&1 < /dev/null &
  ENGINE_PID=$!
  for _ in $(seq 180); do
    curl -sf -o /dev/null --max-time 2 "$ENGINE/oauth/jwks" && { echo "engine ready on $ENGINE"; return; }
    kill -0 "$ENGINE_PID" 2>/dev/null || break
    sleep 1
  done
  echo "engine did not start:" >&2; tail -40 "$LOGS/engine.log" >&2; exit 1
}

engine_stop() {
  kill -TERM "$ENGINE_PID" 2>/dev/null || true
  wait "$ENGINE_PID" 2>/dev/null || true
}

# The engine's own maintenance verbs (superuser, clients), no server needed.
ops() { java -cp "$ENGINE_JAR" clojure.main -m synthigy.ops "$@"; }

# Run a command inside an example's port with that port's committed
# .synthigy/.env loaded, the way `synthigy exec` does locally.
in_port() {
  local dir=$1; shift
  ( cd "/app/$dir" && set -a && . ./.synthigy/.env && set +a && "$@" )
}

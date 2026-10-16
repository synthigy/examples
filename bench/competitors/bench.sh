#!/usr/bin/env bash
# One launcher for every Synthigy bench. Replaces the run_synthigy_*.sh zoo:
# the backend, the observability sink, the audit flag and the harness are
# arguments, not twenty near-identical files.
#
#   ./bench.sh --db sqlite  --obs builtin --audit --harness import
#   ./bench.sh --db postgres --obs builtin --audit --harness import --batch 2000
#   ./bench.sh --db sqlite  --harness depth          # read bench, no reset
#   ./bench.sh --db postgres --mode bare --harness http
#   ./bench.sh --db postgres --obs clickhouse --audit --harness parallel --workers 4
#
# The engine boots through `synthigy exec -f bench.env`, so bench.env owns the
# database credentials and the encryption master key; everything that differs
# per run is set here and overrides the profile.
#
#   --db          sqlite | postgres              (default sqlite)
#   --obs         none | builtin | clickhouse    (default none)
#                   the audit + log-store modules on the classpath:
#                   none = :audit-memory :log-memory (nothing durable),
#                   builtin = :audit-<db> + :log-sqlite (the sqlite/postgres bundles),
#                   clickhouse = :clickhouse :audit-clickhouse :log-clickhouse (postgres only)
#   --audit       audit every entity/relation    (default off)
#   --mode        dev | bare                     (default dev)
#                   dev  = :dev alias autoboots the full :synthigy/server
#                   bare = no :dev, then lifecycle/start! :synthigy/bare-server
#   --harness     import | parallel | pure | http | search | concurrency |
#                 depth | history | setentity | waterfall | profile | none |
#                 hold (boot, write the token to $HOLD_TOKEN_FILE, wait until killed)
#   --batch N     rows per sync-entity call      (default 1000)
#   --workers N   parallel harness workers       (default 4)
#   --client      none | su | nonsu              (default none; http in dev mode needs one —
#                   bare mode is engine-only: no IAM, every request accepted, --client ignored)
#   --no-triggers disable user triggers after deploy (postgres only)
#   --server      httpkit | enso | ring-jetty    (default httpkit)
#   --port N      engine HTTP port               (default 7888)
#   --nrepl N     nREPL port                     (default 8901)
#   --reset / --no-reset   force DB reset on or off
#
# Defaults avoid :7887 on purpose — that is the port a normal `synthigy exec
# -- clj -M:dev:...` development REPL listens on, and a bench must never
# depend on it being free.
#
# Read harnesses (search / concurrency / depth) do NOT reset by default: they
# measure queries against data a write bench already imported.

set -euo pipefail

command -v synthigy >/dev/null 2>&1 || {
  echo "synthigy CLI not found on PATH — install it:" >&2
  echo "  curl -fsSL https://raw.githubusercontent.com/synthigy/synthigy/main/install.sh | sh" >&2
  exit 1
}

DB=sqlite OBS=none AUDIT=false MODE=dev HARNESS=import
BATCH=1000 WORKERS=4 CLIENT=none NO_TRIGGERS=false SERVER=httpkit
PORT=7888 NREPL_PORT=8901 RESET=auto

while [[ $# -gt 0 ]]; do
  case "$1" in
    --db)          DB="$2"; shift 2 ;;
    --obs)         OBS="$2"; shift 2 ;;
    --audit)       AUDIT=true; shift ;;
    --mode)        MODE="$2"; shift 2 ;;
    --harness)     HARNESS="$2"; shift 2 ;;
    --batch)       BATCH="$2"; shift 2 ;;
    --workers)     WORKERS="$2"; shift 2 ;;
    --client)      CLIENT="$2"; shift 2 ;;
    --no-triggers) NO_TRIGGERS=true; shift ;;
    --port)        PORT="$2"; shift 2 ;;
    --server)      SERVER="$2"; shift 2 ;;
    --nrepl)       NREPL_PORT="$2"; shift 2 ;;
    --reset)       RESET=true; shift ;;
    --no-reset)    RESET=false; shift ;;
    -h|--help)     sed -n '2,40p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *)             echo "unknown argument: $1 (try --help)" >&2; exit 1 ;;
  esac
done

case "$DB"  in sqlite|postgres) ;; *) echo "--db must be sqlite or postgres" >&2; exit 1 ;; esac
case "$OBS" in none|builtin|clickhouse) ;; *) echo "--obs must be none, builtin or clickhouse" >&2; exit 1 ;; esac
[[ "$OBS" == clickhouse && "$DB" != postgres ]] && { echo "--obs clickhouse needs --db postgres" >&2; exit 1; }
case "$MODE" in dev|bare) ;; *) echo "--mode must be dev or bare" >&2; exit 1 ;; esac

HERE="$(cd "$(dirname "$0")" && pwd)"
BENCH="$(cd "$HERE/.." && pwd)"
CORE="$(cd "$BENCH/../../core" && pwd)"
MODEL="$BENCH/../datasets/movies/Movies Example@0.4.json"
SERVER_URL="http://localhost:$PORT"
# one instance home per backend; the engine keeps its files in <home>/db/
BENCH_HOME="/tmp/synthigy-bench-$DB"
SQLITE_FILE="$BENCH_HOME/db/synthigy.db"
AUDIT_FILE="$BENCH_HOME/db/audit.db"
LOGS_FILE="$BENCH_HOME/db/logs.db"
# CLICKHOUSE_* are the live names; the SYNTHIGY_AUDIT_CH_* the old scripts
# passed are dead config the observability module never reads.
CH_URL="${CLICKHOUSE_URL:-http://localhost:8123}"
CH_DB="${CLICKHOUSE_DB:-synthigy_audit_bench}"
CH_USER="${CLICKHOUSE_USER:-default}"
# the node harness resolves DATASET under examples/datasets; the MovieLens
# files sit in movies/<variant>, same variant the clj harness picks via MOVIES_DATASET
NODE_DATASET="movies/${MOVIES_DATASET:-movies}"
# a client-credentials mint that names no audience yields a token /data
# soft-401s (synthigy.oauth.core/platform-audience)
AUDIENCE="${SYNTHIGY_AUDIENCE:-https://synthigy.com}"
# the OAuth API row carrying that audience; a client must be linked to it
API="${SYNTHIGY_API_NAME:-Synthigy}"
LOG="/tmp/synthigy-bench-$DB-$OBS.log"
RESULT="/tmp/synthigy-bench-$DB-$OBS-result.edn"

case "$HARNESS" in
  search|concurrency|depth|history|hold) READ_ONLY=true ;;
  *)                        READ_ONLY=false ;;
esac
[[ "$RESET" == auto ]] && { [[ "$READ_ONLY" == true ]] && RESET=false || RESET=true; }

cleanup() {
  if [[ -n "${REPL_PID:-}" ]] && kill -0 "$REPL_PID" 2>/dev/null; then
    kill "$REPL_PID" 2>/dev/null || true
    wait "$REPL_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

repl() { clj-nrepl-eval -p "$NREPL_PORT" --timeout "$1" "$2"; }

await() { # await <label> <seconds> <test-command...>
  local label="$1" secs="$2"; shift 2
  echo "  waiting for $label ..."
  for _ in $(seq 1 "$secs"); do "$@" >/dev/null 2>&1 && { echo "  $label ready"; return 0; }; sleep 1; done
  echo "$label did not come up. Boot log:" >&2; tail -40 "$LOG" >&2; exit 1
}

http_up()  { curl -sf -m 2 "$SERVER_URL/.well-known/synthigy"; }
nrepl_up() { (echo > "/dev/tcp/127.0.0.1/$NREPL_PORT"); }

# ---------------------------------------------------------------- reset ----
if [[ "$RESET" == true ]]; then
  if [[ "$DB" == postgres ]]; then
    echo "=== Resetting synthigy DB (bench-postgres) ==="
    "$HERE/reset_synthigy.sh"
  else
    echo "=== Resetting SQLite at $SQLITE_FILE ==="
    rm -f "$SQLITE_FILE" "$SQLITE_FILE-wal" "$SQLITE_FILE-shm"
  fi
  case "$OBS" in
    builtin)    echo "=== Resetting local audit/log stores ==="
                rm -f "$AUDIT_FILE" "$AUDIT_FILE-wal" "$AUDIT_FILE-shm" "$LOGS_FILE" "$LOGS_FILE-wal" "$LOGS_FILE-shm" ;;
    clickhouse) echo "=== Resetting ClickHouse $CH_DB ==="
                curl -sf -X POST "$CH_URL/" --data "DROP DATABASE IF EXISTS $CH_DB" >/dev/null
                curl -sf -X POST "$CH_URL/" --data "CREATE DATABASE $CH_DB" >/dev/null ;;
  esac
fi

# ----------------------------------------------------------------- boot ----
ALIAS=":engine-$DB"
case "$OBS" in
  builtin)    ALIAS="$ALIAS:audit-$DB:log-sqlite" ;;
  clickhouse) ALIAS="$ALIAS:lib-clickhouse:audit-clickhouse:log-clickhouse" ;;
  *)          ALIAS="$ALIAS:audit-memory:log-memory" ;;
esac
ALIAS="$ALIAS:server-$SERVER"
[[ "$MODE" == dev ]] && ALIAS="$ALIAS:dev"

# :dev is the only alias that carries nrepl, so bare mode has to add it.
SDEPS=()
[[ "$MODE" == bare ]] && SDEPS=(-Sdeps '{:deps {nrepl/nrepl {:mvn/version "1.3.0"}}}')

echo "=== Booting $DB${OBS:+ + $OBS} (mode=$MODE, audit=$AUDIT) ==="
cd "$CORE"
env SYNTHIGY_HOME="$BENCH_HOME" \
    CLICKHOUSE_URL="$CH_URL" CLICKHOUSE_DB="$CH_DB" CLICKHOUSE_USER="$CH_USER" \
    SYNTHIGY_AUDIT_ALL="$AUDIT" SYNTHIGY_IAM_ALLOW_PUBLIC=true \
    SYNTHIGY_SERVER_PORT="$PORT" SYNTHIGY_SERVER_HOST=127.0.0.1 \
  synthigy exec -f "$HERE/bench.env" -- \
    clj "${SDEPS[@]}" -M"$ALIAS" -m nrepl.cmdline --port "$NREPL_PORT" >"$LOG" 2>&1 &
REPL_PID=$!

await "nREPL on :$NREPL_PORT" 180 nrepl_up
if [[ "$MODE" == bare ]]; then
  echo "=== Starting :synthigy/bare-server ==="
  repl 180000 "(require '[patcho.lifecycle :as lc] 'synthigy.server) (lc/start! :synthigy/bare-server) :booted" >/dev/null
fi
await "HTTP on $SERVER_URL" 180 http_up

# :dev boots Dataline itself (dev/user.clj); bare mode starts the same composition
if [[ "$MODE" == bare ]]; then
  echo "=== Starting Dataline ==="
  repl 60000 "(require 'synthigy.dataline) (synthigy.dataline/start!) :dataline-started" >/dev/null
fi

if [[ "$OBS" != none && "$AUDIT" == true ]]; then
  echo "=== Verifying audit is live ==="
  repl 60000 "(require '[patcho.lifecycle :as lc] '[synthigy.audit.policy :as policy] '[synthigy.audit.protocol :as protocol] 'synthigy.dataline)
              {:iam (lc/started? :synthigy/iam) :dataline (synthigy.dataline/health)
               :persists (policy/persistence-enabled?) :provider (some-> protocol/*audit-provider* class .getSimpleName)}"
fi

# --------------------------------------------------------------- deploy ----
if [[ "$RESET" == true ]]; then
  echo "=== Deploying Movies model ==="
  repl 180000 "(require '[synthigy.dataset :as dataset] '[synthigy.transit :as t])
               (dataset/deploy! (t/<-transit (slurp \"$MODEL\"))) :deployed" >/dev/null
fi

if [[ "$NO_TRIGGERS" == true ]]; then
  echo "=== Disabling user triggers ==="
  "$HERE/disable_all_triggers.sh" disable
fi

TOKEN=""
if [[ "$MODE" == bare && "$CLIENT" != none ]]; then
  echo "  (bare mode: no IAM, every request is accepted — ignoring --client $CLIENT)"
  CLIENT=none
fi
if [[ "$CLIENT" != none ]]; then
  echo "=== Creating $CLIENT bench client ==="
  if [[ "$CLIENT" == su ]]; then
    repl 60000 "(require '[synthigy.iam :as iam] '[synthigy.data :as data] '[synthigy.dataset :as dataset] '[synthigy.dataset.id :as id] '[synthigy.supervisor.verbs :as verbs])
                (verbs/add-client! {:id \"bench-write\" :name \"bench-write\" :type :confidential
                                    :secret \"bench-write-secret-2026\" :apis [\"$API\"]
                                    :settings {\"allowed-grants\" [\"client_credentials\"]}})
                (let [u (dataset/get-entity :iam/user {:name \"bench-write\"} {(id/key) nil :name nil})]
                  (dataset/sync-entity :iam/user (assoc (select-keys u [(id/key) :name]) :roles [data/*ROOT*])))
                :client-ready" >/dev/null
    SECRET=bench-write-secret-2026 CLIENT_ID=bench-write
  else
    repl 60000 "(require '[synthigy.supervisor.verbs :as verbs])
                (verbs/add-client! {:id \"bench-nsu\" :name \"bench-nsu\" :type :confidential
                                    :secret \"bench-nsu-secret\" :apis [\"$API\"]
                                    :settings {\"allowed-grants\" [\"client_credentials\"]}})
                :client-ready" >/dev/null
    SECRET=bench-nsu-secret CLIENT_ID=bench-nsu
  fi
  TOKEN="$(curl -s -X POST "$SERVER_URL/oauth/token" \
    -H 'content-type: application/x-www-form-urlencoded' \
    --data "grant_type=client_credentials&client_id=$CLIENT_ID&client_secret=$SECRET&audience=$AUDIENCE" \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(JSON.parse(s).access_token||"")}catch{process.stdout.write("")}})')"
  [[ -z "$TOKEN" ]] && { echo "Failed to mint token" >&2; exit 1; }
  echo "  token acquired (${#TOKEN} chars)"
fi

# -------------------------------------------------------------- harness ----
# Long imports run in a server-side future writing $RESULT, then we poll: a
# single multi-minute nREPL socket EOFs on the client side.
run_future() { # run_future <load-file> <form>
  rm -f "$RESULT"
  echo "=== Running $HARNESS (batch=$BATCH) ==="
  repl 60000 "(load-file \"$1\")
              (load-file \"$HERE/synthigy_drain.clj\")
              (future (let [r (try $2 (catch Throwable t {:error (.getMessage t)}))]
                        (spit \"$RESULT\" (if (string? r) r (pr-str r)))))
              :launched" >/dev/null
  for _ in $(seq 1 3600); do [[ -f "$RESULT" ]] && break; sleep 2; done
  [[ -f "$RESULT" ]] || { echo "Harness did not finish. Boot log:" >&2; tail -40 "$LOG" >&2; exit 1; }
  echo "--- result ---"; cat "$RESULT"; echo
}

DRAIN="synthigy-bench.drain/measure!"

case "$HARNESS" in
  import)      run_future "$HERE/synthigy_import.clj" "($DRAIN #(synthigy-bench.import/run! {:batch $BATCH}))" ;;
  parallel)    run_future "$HERE/synthigy_import_parallel.clj" "($DRAIN #(synthigy-bench.import-parallel/run! {:batch $BATCH :workers $WORKERS}))" ;;
  pure)        run_future "$HERE/synthigy_inproc_pure.clj" "(synthigy-bench.pure/run! $BATCH)" ;;
  setentity)   run_future "$HERE/synthigy_setentity_profile.clj" "(with-out-str (synthigy-bench.setentity-profile/run! $BATCH))" ;;
  search)      repl 300000 "(load-file \"$HERE/synthigy_search.clj\") (synthigy-bench.search/run!)" ;;
  concurrency) repl 900000 "(load-file \"$HERE/synthigy_concurrency.clj\") (synthigy-bench.concurrency/run!)" ;;
  history)     repl 900000 "(load-file \"$HERE/synthigy_history.clj\") (synthigy-bench.history/run! {:n 1000})" ;;
  depth)       repl 900000 "(load-file \"$HERE/synthigy_depth.clj\") (synthigy-bench.depth/run!)" ;;
  waterfall)   repl 60000 "(load-file \"$HERE/synthigy_waterfall.clj\") (synthigy-bench.waterfall/install!)" >/dev/null
               (cd "$BENCH" && SYNTHIGY_URL="$SERVER_URL" SYNTHIGY_TOKEN="$TOKEN" \
                  DATASET="$NODE_DATASET" node competitors/synthigy_http.mjs "$BATCH")
               repl 120000 "(synthigy-bench.waterfall/report!)" ;;
  profile)     repl 60000 "(load-file \"$HERE/synthigy_profile.clj\") (synthigy-bench.profile/install!)" >/dev/null
               (cd "$BENCH" && SYNTHIGY_URL="$SERVER_URL" SYNTHIGY_TOKEN="$TOKEN" \
                  DATASET="$NODE_DATASET" BATCH="$BATCH" node competitors/synthigy_profile_client.mjs)
               repl 120000 "(synthigy-bench.profile/report!)" ;;
  http)        (cd "$BENCH" && SYNTHIGY_URL="$SERVER_URL" SYNTHIGY_TOKEN="$TOKEN" DATASET="$NODE_DATASET" \
                  CONFIG="$DB${OBS:+ + $OBS} mode=$MODE audit=$AUDIT" \
                  node competitors/synthigy_http.mjs "$BATCH") ;;
  none)        echo "=== Booted; no harness (--harness none) ===" ;;
  hold)        [[ -n "${HOLD_TOKEN_FILE:-}" ]] && printf '%s' "$TOKEN" > "$HOLD_TOKEN_FILE"
               echo "=== Holding $SERVER_URL for external load; kill this script to stop ==="
               wait "$REPL_PID" ;;
  *)           echo "unknown --harness: $HARNESS" >&2; exit 1 ;;
esac

# ------------------------------------------------------------ audit tail ---
# The sink drains asynchronously; poll until the row count stops moving so a
# teardown never undercounts.
if [[ "$OBS" == clickhouse && "$AUDIT" == true && "$READ_ONLY" == false ]]; then
  echo "=== Waiting for the audit drainer, then ClickHouse row counts ==="
  prev=-1; stable=0
  for _ in $(seq 1 60); do
    sleep 4
    cur=$(curl -sf -X POST "$CH_URL/" --data "SELECT count() FROM $CH_DB.audit_entity" 2>/dev/null || echo 0)
    if [[ "$cur" == "$prev" ]]; then
      [[ $stable -ge 1 ]] && break
      stable=$((stable+1))
    else
      stable=0
    fi
    prev="$cur"
  done
  for t in audit_entity audit_relation logs; do
    printf '  %-16s %s\n' "$t" "$(curl -sf -X POST "$CH_URL/" --data "SELECT count() FROM $CH_DB.$t" 2>/dev/null || echo '(absent)')"
  done
fi

if [[ "$OBS" == builtin && "$AUDIT" == true && "$READ_ONLY" == false ]]; then
  echo "=== Waiting for the audit drainer, then audit row counts ==="
  if [[ "$DB" == postgres ]]; then
    count() { docker exec bench-postgres psql -U bench -d synthigy -tAc "SELECT count(*) FROM $1"; }
    tables=(__audit_entity __audit_relation)
  else
    count() { sqlite3 "$AUDIT_FILE" "SELECT count(*) FROM $1"; }
    tables=(audit_entity audit_relation)
  fi
  prev=-1; stable=0
  for _ in $(seq 1 60); do
    sleep 4
    cur=$(count "${tables[0]}" 2>/dev/null || echo 0)
    if [[ "$cur" == "$prev" ]]; then
      [[ $stable -ge 1 ]] && break
      stable=$((stable+1))
    else
      stable=0
    fi
    prev="$cur"
  done
  for t in "${tables[@]}"; do printf '  %-18s %s\n' "$t" "$(count "$t")"; done
fi

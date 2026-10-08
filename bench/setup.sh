#!/usr/bin/env bash
# Bring up the isolated bench stack and (re)apply the schema.
# Re-running this is the reset between benchmark runs — schema.sql DROPs
# every table first, so each competitor starts from an empty database.
#
#   ./setup.sh           config A — bare tables, FK columns, no audit
#   ./setup.sh audit     config B — + audit triggers
#   ./setup.sh junctions feature-matched — every relation a junction table
#                        (Synthigy's data model), no audit
set -euo pipefail
cd "$(dirname "$0")"

MODE="${1:-base}"

docker compose up -d

echo "Waiting for bench-postgres..."
until docker exec bench-postgres pg_isready -U bench -d bench >/dev/null 2>&1; do
  sleep 1
done

if [[ "$MODE" == "junctions" ]]; then
  echo "Applying schema-junctions.sql (feature-matched — junction per relation)..."
  docker exec -i bench-postgres psql -U bench -d bench -q < schema-junctions.sql
else
  echo "Applying schema.sql (drops + recreates all tables)..."
  docker exec -i bench-postgres psql -U bench -d bench -q < schema.sql
fi

if [[ "$MODE" == "audit" ]]; then
  echo "Applying schema-audit.sql (audit triggers — config B)..."
  docker exec -i bench-postgres psql -U bench -d bench -q < schema-audit.sql
fi

# PostgREST caches the schema at connect time — it started before schema.sql
# ran, so its cache is stale. Reload it so the bench-postgrest API exposes
# the freshly-created tables.
if docker ps --format '{{.Names}}' | grep -q '^bench-postgrest$'; then
  docker exec bench-postgres psql -U bench -d bench -q \
    -c "NOTIFY pgrst, 'reload schema';" >/dev/null 2>&1 || true
  echo "PostgREST schema cache reloaded."
fi

echo "Bench stack ready — postgres :5433, hasura :8088, postgrest :3001 — mode=$MODE"

#!/usr/bin/env bash
# Reset the bench `synthigy` DB to a clean slate.
#
# Usage: ./reset_synthigy.sh
#
# Drops and recreates the synthigy DB in bench-postgres. After this, the
# running Synthigy REPL needs to:
#   - lifecycle/stop-all! then lifecycle/start! :synthigy/bare-server
#   - dataset/deploy! v   (redeploy the Movies model)
#
# (The boot script in synthigy_server_boot.clj does the re-deploy; or do
# it interactively in the REPL.)

set -euo pipefail
docker exec bench-postgres psql -U bench -d postgres -c "DROP DATABASE IF EXISTS synthigy"
docker exec bench-postgres psql -U bench -d postgres -c "CREATE DATABASE synthigy OWNER bench"
echo "synthigy DB reset."

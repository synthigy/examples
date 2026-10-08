#!/usr/bin/env bash
# Disable ALL user triggers on every Synthigy data table in bench-postgres.
# Lets the HTTP bench measure the audit-trigger-free path so we can see
# what bare-server's audit-substrate overhead actually costs end-to-end.
#
# Usage: ./disable_all_triggers.sh [enable|disable]
set -euo pipefail
ACTION="${1:-disable}"

case "$ACTION" in
  disable|enable) ;;
  *) echo "Usage: $0 [enable|disable]"; exit 1 ;;
esac

VERB=$(echo "$ACTION" | tr a-z A-Z)

docker exec bench-postgres psql -U bench -d synthigy -At -c "
SELECT 'ALTER TABLE ' || quote_ident(tablename) || ' $VERB TRIGGER USER;'
FROM pg_tables
WHERE schemaname='public'
  AND tablename NOT LIKE '\\_\\_%'
  AND tablename NOT LIKE 'dataset%'
  AND tablename NOT LIKE 'data\\_%';
" | docker exec -i bench-postgres psql -U bench -d synthigy -q

echo "All user triggers ${ACTION}d on Synthigy data tables."

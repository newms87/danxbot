#!/bin/bash
# describe-tables.sh — Get field lists for specified database tables.
# Usage: ./describe-tables.sh table1 table2 table3
#
# Returns DESCRIBE output for each table, plus foreign key constraints.
# Used by the Danxbot agent to verify schema before constructing queries.

if [ $# -eq 0 ]; then
  echo "Usage: describe-tables.sh <table1> [table2] [table3] ..."
  echo "Returns DESCRIBE output and foreign keys for each table."
  exit 1
fi

MYSQL_CMD=(mysql -h "$PLATFORM_DB_HOST" -u "$PLATFORM_DB_USER" -p"$PLATFORM_DB_PASSWORD" "$PLATFORM_DB_NAME")

for table in "$@"; do
  # Validate table name: only alphanumeric and underscores allowed
  if [[ ! "$table" =~ ^[a-zA-Z0-9_]+$ ]]; then
    echo "ERROR: Invalid table name '$table'"
    echo ""
    continue
  fi

  echo "=== $table ==="
  echo ""
  echo "--- Columns ---"
  "${MYSQL_CMD[@]}" -e "DESCRIBE \`$table\`" 2>&1 | grep -v "Using a password"
  if [ "${PIPESTATUS[0]}" -ne 0 ]; then
    echo "ERROR: Table '$table' not found"
    echo ""
    continue
  fi
  echo ""
  echo "--- Foreign Keys ---"
  "${MYSQL_CMD[@]}" -e "
    SELECT COLUMN_NAME, REFERENCED_TABLE_NAME, REFERENCED_COLUMN_NAME
    FROM information_schema.KEY_COLUMN_USAGE
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = '$table'
      AND REFERENCED_TABLE_NAME IS NOT NULL
  " 2>&1 | grep -v "Using a password"
  echo ""
done

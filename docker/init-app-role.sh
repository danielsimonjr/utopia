#!/bin/bash
# This script creates the restricted role for the application's runtime connection. It runs only
# on first initialization, when the data directory is empty (the Postgres official image runs
# every script under docker-entrypoint-initdb.d at that time only). An existing deployment is not affected.
#
# This script does not grant permissions. Migration 0031 grants them, so each upgrade can add
# permissions for new tables. This script only creates the role and sets its login password.
set -euo pipefail

APP_PASSWORD="${UTOPIA_APP_DB_PASSWORD:-}"
if [ -z "$APP_PASSWORD" ]; then
    echo "UTOPIA_APP_DB_PASSWORD is not set. Skipping restricted role creation. The application will run as the owner." >&2
    exit 0
fi

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<SQL
DO \$\$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'utopia_app') THEN
        CREATE ROLE utopia_app LOGIN PASSWORD '${APP_PASSWORD}';
        RAISE NOTICE 'Created restricted role utopia_app';
    END IF;
END
\$\$;
GRANT CONNECT ON DATABASE "$POSTGRES_DB" TO utopia_app;
SQL

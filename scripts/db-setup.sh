#!/usr/bin/env bash
# Create local PostgreSQL roles and databases for Tracklibute development.
# Idempotent. Requires a local superuser (default: the `postgres` OS user).
#
#   tracklibute_owner — owns the schema; used for migrations, seed, test fixtures
#   tracklibute_app   — runtime role: NOT superuser, NOT BYPASSRLS, NOT owner
#
# Passwords below are for local development only.
set -euo pipefail

# Override with e.g. PSQL="psql -h localhost -U postgres" for a non-default superuser.
run_sql() {
  if [ -n "${PSQL:-}" ]; then $PSQL -v ON_ERROR_STOP=1 -q
  elif [ "$(id -u)" = "0" ]; then su postgres -c "psql -v ON_ERROR_STOP=1 -q"
  else sudo -u postgres psql -v ON_ERROR_STOP=1 -q
  fi
}

run_sql <<'SQL'
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tracklibute_owner') THEN
    CREATE ROLE tracklibute_owner LOGIN PASSWORD 'tracklibute_owner_dev' NOSUPERUSER CREATEDB;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tracklibute_app') THEN
    CREATE ROLE tracklibute_app LOGIN PASSWORD 'tracklibute_app_dev'
      NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END $$;
SELECT 'CREATE DATABASE tracklibute_dev OWNER tracklibute_owner'
  WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'tracklibute_dev') \gexec
SELECT 'CREATE DATABASE tracklibute_test OWNER tracklibute_owner'
  WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'tracklibute_test') \gexec
SQL

echo "Roles and databases ready: tracklibute_dev, tracklibute_test"

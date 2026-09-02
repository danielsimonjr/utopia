-- Before this migration, the application connected as the database owner (a superuser).
-- That role can run DROP TRIGGER, or change any table, so the immutability trigger
-- migration 0026 added to the ledger meant nothing to anyone holding the application's
-- connection string: DISABLE TRIGGER, edit the row, ENABLE TRIGGER, three statements,
-- with no trace afterward.
--
-- The restricted role limits the application to what it actually needs: full read and
-- write access to business tables, and insert-and-read-only access to the ledger. With
-- this role, the same three statements fail on the first one, with "must be owner of table."
--
-- This layer stops application bugs, permissions inherited through SQL injection, and a
-- leaked connection string (in a log, a backup, or a mistakenly committed .env file). It
-- does not stop someone who can log into the server itself: psql inside the container
-- uses trust authentication, so no password is needed to connect as superuser. That case
-- belongs to server access control, a separate concern from this migration.
--
-- This whole block is skipped when the role does not exist, so an existing deployment
-- that never creates this role, and never changes its connection string, keeps running
-- unchanged. ALTER DEFAULT PRIVILEGES must stay inside this same check; running it
-- outside the DO block would raise an error for a missing role and stop the migration,
-- which would fail every existing deployment's upgrade.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'utopia_app') THEN
        RAISE NOTICE 'Role utopia_app does not exist. Skipping restricted-role setup. The application keeps running under its current role.';
        RETURN;
    END IF;

    GRANT USAGE ON SCHEMA public TO utopia_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO utopia_app;
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO utopia_app;
    GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO utopia_app;

    -- The ledger: this role can insert and read, but cannot update or delete rows.
    REVOKE UPDATE, DELETE, TRUNCATE ON audit_events FROM utopia_app;

    -- Any table, sequence, or function a later migration creates gets this same grant
    -- automatically; without this, adding a table would break the application with a
    -- permissions error. PL/pgSQL does not accept this utility command written directly,
    -- so this runs through EXECUTE.
    EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA public '
         || 'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO utopia_app';
    EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA public '
         || 'GRANT USAGE, SELECT ON SEQUENCES TO utopia_app';
    EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA public '
         || 'GRANT EXECUTE ON FUNCTIONS TO utopia_app';

    RAISE NOTICE 'Restricted permissions for utopia_app are configured.';
END $$;

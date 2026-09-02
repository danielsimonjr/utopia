-- The audit log: who did what, to what, and when. This table exists for audit purposes
-- only; it does not support a revert or any other derived feature.
--
-- **kb_id and actor_id are plain UUID columns, with no foreign key.** The ledger must not
-- depend on the objects it records staying alive. If kb_id had a cascading delete,
-- deleting a knowledge base would delete every audit record about it, including the
-- kb.deleted record just written for that deletion. Deletion is the action that most
-- needs a record, and it would be the one action left with no record. If actor_id used
-- SET NULL, every confirmation, rejection, and merge a user made would turn anonymous the
-- moment that user's account is deactivated. Compliance review needs exactly these two
-- cases covered.
--
-- This also sets up the hash chain: the chain requires that records are only ever added,
-- never removed. A cascading delete would remove a link from the middle of the chain,
-- and the break would look legitimate, with no way to tell that it happened.
CREATE TABLE audit_events (
    id          UUID PRIMARY KEY,
    kb_id       UUID,
    actor_id    UUID,
    action      TEXT NOT NULL,
    target_kind TEXT NOT NULL,
    target_id   UUID,
    -- The key facts of the change, in whatever shape fits the action.
    detail      JSONB NOT NULL DEFAULT '{}',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Where the action came from. ISO 27001 control A.8.15 requires a log to cover
    -- "where" and "how," meaning the origin of the request. Without this, every action
    -- taken through a stolen account would look identical to the account owner's own actions.
    -- Both columns can be NULL: a background job (batched judgment, a scheduled sync) has
    -- no client, and a NULL value here is correct for that case.
    client_ip   TEXT,
    user_agent  TEXT,
    -- A snapshot of the actor's identity. actor_id has no foreign key, so the row
    -- survives after a user is deactivated, but a LEFT JOIN against users then returns no
    -- name, and the interface would show only a UUID. Storing the email and display name
    -- as they were at the time makes this ledger self-contained.
    actor_label TEXT
);
CREATE INDEX audit_events_kb_time_idx ON audit_events (kb_id, created_at DESC);

-- This index supports lookup by IP address (failed sign-ins from one origin, or activity
-- at an unusual time).
CREATE INDEX audit_events_client_ip_idx ON audit_events (client_ip, created_at DESC)
    WHERE client_ip IS NOT NULL;

-- This ledger only grows; it never changes in place. The application already only runs
-- INSERT statements. This trigger blocks the path that bypasses the application: a direct
-- database connection from an operator, an accidental UPDATE, or someone trying to erase
-- their own trace later.
--
-- This trigger cannot stop a superuser, because that role can run DROP TRIGGER or ALTER
-- TABLE ... DISABLE TRIGGER and then edit freely. So this layer raises the bar from "an
-- easy edit" to "requires a DDL change first," and a DDL change stays in the database's own
-- log. Catching deliberate tampering needs the hash chain described elsewhere: an edited
-- row breaks the chain at that exact point.
--
-- There is no bypass switch at the application layer, on purpose. Audit immutability with
-- a switch is the same as no immutability. If retention cleanup becomes necessary later,
-- that is a privileged operator action: it should run DROP TRIGGER explicitly, clean up,
-- and recreate the trigger, with every step recorded in the DDL log.
CREATE FUNCTION audit_events_immutable() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'audit_events is append-only (attempted %)', TG_OP
        USING HINT = 'Audit records cannot be modified or deleted.';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_events_no_update_delete
    BEFORE UPDATE OR DELETE ON audit_events
    FOR EACH ROW EXECUTE FUNCTION audit_events_immutable();

-- TRUNCATE does not fire a row-level trigger, so this statement-level trigger blocks it
-- separately; without it, a single TRUNCATE statement would bypass every rule above.
CREATE TRIGGER audit_events_no_truncate
    BEFORE TRUNCATE ON audit_events
    FOR EACH STATEMENT EXECUTE FUNCTION audit_events_immutable();

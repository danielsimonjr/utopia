-- The alert center (see ADR 0005). Before this table, failure state was spread across six
-- places: jobs.last_error, documents.status, documents.graph_status,
-- sources.last_sync_status, source_sync_runs.status, and the logs. Each new kind of
-- failure added one more column to one of these tables, and the reasoning layer, the
-- execution layer, OCR, and lakehouse connections had not even been added yet.
--
-- The real risk was never the failure itself. It was **a failure with no visible
-- trace.** Upload 100 PDFs, and 12 of them are scanned images with no text; the
-- interface shows all 100 as green.

-- **One row per failure, written once, and never changed after that.**
--
-- This table has no state machine on purpose: no "resolved" state, no self-healing, no
-- collapsing several failures into one row. An earlier version had all of that, and the
-- cost was that every new alert kind needed its own answer to "how do we know this is
-- fixed." source.sync_failed has a natural success signal; llm.unreachable does not, so
-- it needed a separate background probe built just for it. A third alert kind would need
-- a third mechanism, and a missing "clear" step would not show up at compile time.
--
-- The deeper reason is that **"is this still broken right now" is not a question the
-- alert center needs to answer.** The source page already shows that. The document
-- status already shows that. An alert's job is to make a person look, not to act as a
-- live dashboard.
CREATE TABLE alerts (
    id           UUID PRIMARY KEY,
    -- NULL means a system-level alert (an unreachable endpoint, an exhausted connection
    -- pool), visible only to an is_admin user.
    kb_id        UUID REFERENCES knowledge_bases(id) ON DELETE CASCADE,
    severity     TEXT NOT NULL CHECK (severity IN ('info', 'warning', 'error')),
    -- 'source.sync_failed' / 'llm.unreachable' / ...
    kind         TEXT NOT NULL,
    -- This value lives on the row instead of being hardcoded by kind, because the same
    -- alert kind needs a different audience in different situations. A configuration
    -- alert (an endpoint, a quota) should reach an admin; a content alert (parsing,
    -- extraction, sync) should also reach an editor, because the person who uploaded
    -- those 12 scanned files needs to know "what you uploaded did not go in" more than
    -- the administrator does.
    min_role     TEXT NOT NULL CHECK (min_role IN ('viewer', 'editor', 'admin', 'owner')),
    -- The object with the problem: document / source / system. A system-level alert
    -- leaves both of these columns empty.
    subject_type TEXT,
    subject_id   UUID,
    -- The part meant for a person to read: a name, the raw error text.
    detail       JSONB NOT NULL DEFAULT '{}',
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The list sorts by time, newest first; this is the only sort order it supports.
CREATE INDEX alerts_recent_idx ON alerts (created_at DESC);
CREATE INDEX alerts_kb_idx ON alerts (kb_id);

-- Read state is per person.
--
-- An earlier design considered a shared read state, where any administrator opening an
-- alert marked it read for everyone. That design failed in practice: with three
-- administrators, if A opened an alert in the morning, glanced at it, and moved on
-- without acting, the alert **disappeared from B's and C's unread list permanently.**
-- Neither B nor C would know it had ever appeared, while A assumed someone would handle
-- it later. Everyone assumed someone else was handling it, and nothing afterward could
-- reveal that it had fallen through.
--
-- An alert row never changes after it is written, so its read state is also a one-time
-- fact: once read, it stays read.
CREATE TABLE alert_reads (
    alert_id UUID NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
    user_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    read_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (alert_id, user_id)
);

-- Personal access tokens: a long-lived key for an MCP client (see docs/decisions/0014).
--
-- **A token acts as this person, but it does not have to carry all of that person's power.**
--
--     effective permissions = this person's role INTERSECTED WITH this token's scope
--
-- This is an intersection, not a union: a viewer's token with the write flag checked is
-- still read-only. Scope sets an upper bound; it does not grant new access.
--
-- Why this migration does not issue machine tokens (a path considered and set aside in
-- ADR 0014): a machine identity would introduce a third authorization model, and
-- audit_events.actor_id would gain a new kind of row that no person performed — and the
-- ledger exists specifically to answer "who confirmed what, and when."
CREATE TABLE personal_tokens (
    id           UUID PRIMARY KEY,
    -- **This foreign key cascades, the opposite of audit_events.actor_id's plain UUID.**
    -- The ledger must outlive a user; a key should not. When a person is gone, their key
    -- should be gone with them.
    user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    -- A name the person chose themselves, such as "my laptop." This lets them recognize
    -- which key they are revoking.
    name         TEXT NOT NULL,

    -- **This column stores a hash, the opposite of sources.ingest_token's plain text.**
    --
    -- That column's reasoning was "if the database is compromised, the document content
    -- is already exposed, so hashing adds no protection," and that holds because
    -- ingest_token can only **push documents in**. This key is different: through
    -- query_data, it can read from a production database outside Utopia entirely. That
    -- data warehouse runs on a different machine, holding a different set of data, and it
    -- must not be exposed just because Utopia's own database was. **The blast radius
    -- differs, so the storage method differs too.**
    token_hash   TEXT NOT NULL UNIQUE,
    -- A prefix for a person to recognize (utp_ab12...). The list view can match this
    -- against the string in a configuration file, without keeping the full plain-text token around.
    token_prefix TEXT NOT NULL,

    -- read = read-only tools; write = also allows remember. **This defaults to
    -- read-only**; letting an agent write to the ledger needs an explicit choice.
    scope        TEXT NOT NULL DEFAULT 'read' CHECK (scope IN ('read', 'write')),
    -- Restricts this token to specific knowledge bases. NULL means every base this
    -- person can access. This is a plain UUID array, not out of convenience: when a base
    -- is deleted, this entry simply loses effect; deleting the base must not delete the token entirely.
    kb_ids       UUID[],

    -- NULL means no expiration. The interface defaults new tokens to 90 days; no
    -- expiration is an available choice, not the default.
    expires_at   TIMESTAMPTZ,
    -- Answers "is this token still in use." A person needs this answer before revoking a
    -- token, or no one will feel safe revoking anything.
    last_used_at TIMESTAMPTZ,
    -- **A revoke does not delete the row.** The fact that a revoke happened must leave
    -- its own trace. Deleting the row would make "this key existed" unanswerable, and
    -- that is the first question a later investigation asks.
    revoked_at   TIMESTAMPTZ,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Validation is a hot path: **every tool call checks this, not just once at the
-- handshake.** This follows the lesson of migration 0014_data_source_grants: filtering a
-- list is not the same as guarding access. The equivalent mistake in MCP would be
-- "trusting a connection for its entire lifetime," when a revoked_at value written
-- mid-connection must take effect immediately.
CREATE UNIQUE INDEX personal_tokens_hash_idx ON personal_tokens (token_hash);
-- "Which tokens did I issue": the account page lists them per person, most recent first.
CREATE INDEX personal_tokens_user_idx ON personal_tokens (user_id, created_at DESC);

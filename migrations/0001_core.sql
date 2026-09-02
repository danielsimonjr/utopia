-- Core: multi-tenant tables, the job queue, access control, and deployment settings.
-- This creates the pgvector extension early, because chunks.embedding in migration 0002
-- depends on it. The pgvector/pgvector image ships this extension already.
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE organizations (
    id          UUID PRIMARY KEY,
    name        TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE users (
    id            UUID PRIMARY KEY,
    org_id        UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    -- **Uniqueness applies only to active accounts.** See the partial index below.
    -- After deactivation, the email address becomes free again. Without this rule,
    -- deactivating a user would permanently retire that email address, and the same
    -- person could never create a new account with it.
    email         TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    display_name  TEXT NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- The system administrator in a single-tenant deployment. The first registered
    -- user gets this flag automatically. See accounts.rs.
    is_admin      BOOLEAN NOT NULL DEFAULT FALSE,
    -- **This is a soft delete, not a DELETE statement.** Audit events, merge logs, the
    -- type-change ledger, and confirmed mappings all store this user's ID as `actor_id`,
    -- and those rows are audit material. The system must still answer "who did this"
    -- after the person leaves. Deactivation only blocks access: `find_user_by_email` and
    -- `find_user_by_id` each add a `deactivated_at IS NULL` condition. The first check
    -- blocks sign-in; the second blocks a token already issued, because session checks
    -- use `find_user_by_id`, so deactivation takes effect immediately.
    deactivated_at TIMESTAMPTZ,
    -- The user who deactivated this account. This foreign key has no ON DELETE rule,
    -- because the person who deactivated this account can later be deactivated too,
    -- and this record must still point at them.
    deactivated_by UUID REFERENCES users(id)
);

-- Email addresses are unique, **but only among active accounts.** A deactivated account
-- can share its email address with another account. Every query that looks up a user by
-- email must add `deactivated_at IS NULL` anyway, to block sign-in for a deactivated
-- account. This index makes that same condition also enforce correctness.
CREATE UNIQUE INDEX users_email_active_idx ON users (email) WHERE deactivated_at IS NULL;

CREATE TABLE workspaces (
    id          UUID PRIMARY KEY,
    org_id      UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE memberships (
    user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    role         TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'editor', 'viewer')),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, workspace_id)
);
CREATE INDEX memberships_workspace_idx ON memberships (workspace_id);

CREATE TABLE knowledge_bases (
    id           UUID PRIMARY KEY,
    workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    name         TEXT NOT NULL,
    kind         TEXT NOT NULL DEFAULT 'knowledge' CHECK (kind IN ('knowledge', 'memory')),
    description  TEXT,
    -- The deployment's shared default base (the first base created in a workspace).
    -- This base stays open and cannot be deleted; the API enforces both rules.
    is_default   BOOLEAN NOT NULL DEFAULT FALSE,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- An open base with no row in the member matrix follows the deployment role of the
    -- viewer. A restricted base is visible only to the members listed in kb_members;
    -- anyone else gets a NotFound response.
    visibility   TEXT NOT NULL DEFAULT 'open'
                 CHECK (visibility IN ('open', 'restricted')),
    -- Whether the system may extend the ontology on this base's behalf. **This is an
    -- explicit setting, not a value inferred from past behavior.** An earlier design
    -- inferred it from whether the ontology had ever been edited, and that produced a
    -- bad result: one click on "Add" in a proposal would permanently turn off the
    -- suggestion feature, because that click recorded an ontology change with an
    -- operator attached. Once this value turns false, it also stayed false forever, and
    -- the ontology stayed frozen on the vocabulary of the first batch of documents, even
    -- as more documents kept arriving every day.
    auto_extend_ontology BOOLEAN NOT NULL DEFAULT TRUE,
    -- **This is not the "system language"** (see docs/decisions/0004). The interface
    -- language lives in the client; the backend has no locale setting. This column
    -- controls the **language of the corpus**. A class description passes word-for-word
    -- into the extraction prompt, and the reader of that prompt is the model reading
    -- your documents. A description in the same language as the text under judgment
    -- produces a more stable judgment. So a Chinese team reading English technical
    -- documents should set the interface to Chinese and this column to 'en'. One
    -- setting cannot control both things.
    --
    -- This CHECK constraint holds the allowed values, instead of a check in the
    -- application layer, because this column selects a table of compile-time constants.
    -- A value with no matching table would silently fall back to English instead of
    -- raising an error, and that kind of error is hard to find.
    ontology_lang TEXT NOT NULL DEFAULT 'en',
    -- The default base stays open at all times. The API enforces this rule; this
    -- constraint is a second guard at the database level.
    CONSTRAINT kb_default_open CHECK (NOT is_default OR visibility = 'open'),
    CONSTRAINT knowledge_bases_ontology_lang_chk CHECK (ontology_lang IN ('en', 'zh'))
);
CREATE INDEX knowledge_bases_workspace_idx ON knowledge_bases (workspace_id);

-- The job queue. Workers claim rows with FOR UPDATE SKIP LOCKED. See docs/DESIGN.md, section 2.
CREATE TABLE jobs (
    id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    kind         TEXT NOT NULL,
    payload      JSONB NOT NULL DEFAULT '{}',
    status       TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'done', 'failed')),
    attempts     INT NOT NULL DEFAULT 0,
    max_attempts INT NOT NULL DEFAULT 3,
    run_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    locked_at    TIMESTAMPTZ,
    last_error   TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX jobs_claim_idx ON jobs (run_at) WHERE status = 'queued';

-- Workspace-level LLM settings. The chat model and the embedding model use separate
-- settings, through an OpenAI-compatible protocol.
CREATE TABLE llm_settings (
    workspace_id   UUID PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
    chat_base_url  TEXT,
    chat_api_key   TEXT,
    chat_model     TEXT,
    embed_base_url TEXT,
    embed_api_key  TEXT,
    embed_model    TEXT,
    embed_dim      INT,
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Access control at the knowledge base level. A deployment role attaches to a hidden
-- workspace and does not change the memberships table. Each knowledge base keeps its
-- own role matrix, configured from that base's own Settings page.
CREATE TABLE kb_members (
    kb_id      UUID NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
    user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role       TEXT NOT NULL CHECK (role IN ('viewer', 'editor', 'admin')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- The user who added this member. This stays NULL when no user can be credited;
    -- the display then falls back to showing only the time.
    added_by   uuid REFERENCES users(id) ON DELETE SET NULL,
    PRIMARY KEY (kb_id, user_id)
);

CREATE TABLE deployment_settings (
    singleton         BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
    open_registration BOOLEAN NOT NULL DEFAULT TRUE,
    -- The number of concurrent job workers. An administrator can change this system
    -- setting, and the scheduler loop reads it live, so a change takes effect immediately.
    -- **This is an outer backstop, not the main throttle.** The main throttle is the
    -- per-model semaphore described under model_concurrency below. This setting only
    -- stops unbounded growth in the job queue. Set it well above the sum of the
    -- per-model limits; otherwise, a throttled job can fill every worker slot and starve
    -- every other job.
    worker_concurrency INT NOT NULL DEFAULT 32
        CHECK (worker_concurrency BETWEEN 1 AND 32),
    -- The character budget for the ontology section of the extraction prompt. Past this
    -- limit, the system switches to retrieving candidate classes per chunk instead of
    -- inlining the whole ontology. This setting lives in deployment settings, not an
    -- environment variable, because it must change without a restart. Tuning this value
    -- needs a side-by-side comparison of full inlining against per-chunk retrieval, at
    -- each ontology size. Restarting the server between each change would stop anyone
    -- from running that comparison a second time. The value 24000 characters (about
    -- 6000 tokens) is a starting estimate, until that comparison sets a better one.
    ontology_prompt_budget INTEGER NOT NULL DEFAULT 24000,
    -- The default concurrency limit for a model with no row in model_concurrency.
    default_model_concurrency INT NOT NULL DEFAULT 10,
    -- The JWT signing key. **Utopia generates this key automatically on first start.**
    -- This removes the choice between "follow the README and start the server" and
    -- "stay secure": a hardcoded default like dev-secret-change-me in production is the
    -- kind of mistake a warning in a document cannot prevent. UTOPIA_JWT_SECRET still
    -- takes priority over this column. Set the environment variable to rotate the key,
    -- or to align several instances on one key; that path stays open.
    jwt_secret TEXT,
    -- The default value of ontology_lang for a new knowledge base. See the comment on
    -- knowledge_bases.ontology_lang for what this setting controls.
    default_ontology_lang TEXT NOT NULL DEFAULT 'en',
    CONSTRAINT deployment_default_ontology_lang_chk
        CHECK (default_ontology_lang IN ('en', 'zh'))
);
INSERT INTO deployment_settings DEFAULT VALUES;

-- Concurrency limits apply **per model, not per deployment.** The real constraint is the
-- model provider's rate limit, and that limit applies per model and per base_url. A local
-- Ollama instance might handle only 2 concurrent requests, while a hosted API might
-- handle 50. One global number cannot describe both.
--
-- This limit applies at the point where the system calls the LLM, not at job scheduling.
-- A job that calls no model (a folder sync) must not count against this limit, and jobs
-- that call different models (chat for extraction, embedding for ingest) must not compete
-- for the same limit.
CREATE TABLE model_concurrency (
    base_url        TEXT NOT NULL,
    model           TEXT NOT NULL,
    max_concurrent  INT  NOT NULL CHECK (max_concurrent BETWEEN 1 AND 256),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (base_url, model)
);

-- Ingest pipeline: sources, documents, chunks, versions, and sync records.

-- A source is a folder. It is a container in the Library that holds the documents it
-- ingested, and it can sync on a schedule.
-- kind: upload (a virtual owner for a manually uploaded document; source_id is usually
-- NULL) | watch_folder | url | rss | api.
-- See docs/DESIGN.md, section 4, for the ingest channel design.
CREATE TABLE sources (
    id         UUID PRIMARY KEY,
    kb_id      UUID NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
    kind       TEXT NOT NULL DEFAULT 'upload',
    name       TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Settings specific to each source kind (a URL list, an RSS address, a selector, and
    -- so on). The shape changes with kind, so this column is JSONB instead of a set of
    -- mostly-empty columns.
    config     JSONB NOT NULL DEFAULT '{}',
    -- NULL means the source syncs only when triggered by hand.
    sync_interval_minutes INTEGER,
    last_sync_at     TIMESTAMPTZ,
    last_sync_status TEXT NOT NULL DEFAULT 'never'
                     CHECK (last_sync_status IN ('never', 'queued', 'running', 'ok', 'failed')),
    last_sync_error  TEXT,
    last_sync_added  INTEGER NOT NULL DEFAULT 0,
    icon       TEXT,
    -- A cron expression (the standard 5-field form). This column and
    -- sync_interval_minutes are mutually exclusive. The interface builds this value with
    -- a visual picker; only Advanced mode exposes the raw expression.
    sync_cron  TEXT,
    -- **This token is stored in the clear, not hashed.** In a self-hosted deployment,
    -- storing it as a "view once" secret only adds risk: an editor can already read it
    -- again through its own endpoint (open to Editor role only). If the database is
    -- compromised, the document content is already exposed, so hashing this token adds
    -- no protection. The Rotate action stays available for a real leak.
    ingest_token TEXT
);
CREATE INDEX sources_kb_idx ON sources (kb_id);

CREATE TABLE documents (
    id              UUID PRIMARY KEY,
    kb_id           UUID NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
    source_id       UUID REFERENCES sources(id) ON DELETE SET NULL,
    filename        TEXT NOT NULL,
    mime            TEXT NOT NULL DEFAULT 'application/octet-stream',
    size_bytes      BIGINT NOT NULL DEFAULT 0,
    sha256          TEXT NOT NULL,
    -- pending -> parsing -> indexing -> embedding -> ready | failed
    status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'parsing', 'indexing', 'embedding', 'ready', 'failed')),
    error           TEXT,
    -- The document's time value: it has a confidence level and a person can edit it.
    -- See DESIGN.md, section 4.2.
    doc_time        TIMESTAMPTZ,
    doc_time_source TEXT NOT NULL DEFAULT 'file_mtime',
    text_len        INT NOT NULL DEFAULT 0,
    chunk_count     INT NOT NULL DEFAULT 0,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- The graph extraction status. **This status is separate from the ingest pipeline
    -- status.** The two-stage design lets search work as soon as parsing finishes, while
    -- extraction runs on its own, slower schedule.
    graph_status    TEXT NOT NULL DEFAULT 'none'
                    CHECK (graph_status IN ('none', 'queued', 'extracting', 'done', 'failed')),
    -- Document tags, for filtering and bulk organization. This column is not a folder
    -- system for entities.
    --
    -- **This column has stayed empty through four migrations, on purpose.** No code
    -- writes it, reads it, or exposes it. `set_document_tags` has zero callers, and the
    -- frontend never mentions this field name. It survived three migration squashes
    -- (53 to 19 to 10), and no one raised it in any of them.
    --
    -- This column stays for a reason, not by oversight. **Tags may become the only
    -- dimension on this table that a person sets by hand.** The source column records
    -- where a document came from; the name and status columns come from the system.
    -- None of the three express a cross-source grouping that only a person would know,
    -- such as "this batch needs redaction" or "the Q3 set."
    --
    -- The case against tags holds too. Utopia's core claim is that **the graph is the
    -- organizing structure**, and migrations 0009, 0010, and 0011 removed mechanisms
    -- that duplicated the ontology for that reason. Adding this column would build a
    -- second organizing system next to the graph. There is also a sharper question: the
    -- most common real need behind a tag is "I have not reviewed this yet," and that is
    -- not a tag. It is a **review state**, and a review state deserves its own
    -- first-class representation.
    --
    -- This question stays open, pending outside input. To the next person who wants to
    -- remove dead code: this comment is the conclusion of that discussion. Do not delete this column.
    tags            TEXT[] NOT NULL DEFAULT '{}',
    -- The document's logical identity within its source (a watch_folder relative path,
    -- a URL, an RSS guid, or an API external_id). Ingest uses this value to decide
    -- between three outcomes: new, changed, or unchanged. A content change replaces the
    -- same document in place instead of adding a new one; the old version is recorded in
    -- document_versions.
    external_key    TEXT,
    -- This timestamp is set when a file disappears from its folder. **The default
    -- behavior is to keep the document, not delete it.**
    missing_since   TIMESTAMPTZ,
    -- The reason extraction failed. This is a separate column from error, because that
    -- column belongs to the parsing pipeline (set_status clears it), and the two columns
    -- must not interfere with each other.
    graph_error     TEXT,
    -- The ownership token for the extraction job. Incrementing this value on a re-extract
    -- "dismisses" the job that is currently running: after that job finishes each chunk,
    -- it reads this value again, and it exits quietly if the value changed, leaving the
    -- document to the new job. Checking graph_status alone is not reliable here, because
    -- the new job writes that status back to extracting, and the old job cannot tell the difference.
    extract_epoch   INT NOT NULL DEFAULT 0
);
CREATE INDEX documents_kb_idx ON documents (kb_id, created_at DESC);
CREATE INDEX documents_tags_idx ON documents USING gin (tags);
CREATE UNIQUE INDEX documents_kb_sha_idx ON documents (kb_id, sha256);

CREATE TABLE chunks (
    id           UUID PRIMARY KEY,
    kb_id        UUID NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
    document_id  UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    seq          INT NOT NULL,
    text         TEXT NOT NULL,
    heading      TEXT,
    char_start   INT NOT NULL DEFAULT 0,
    char_end     INT NOT NULL DEFAULT 0,
    -- The dimension varies with the chosen embedding model. At this stage, search does a
    -- sequential scan; past a certain size, add an HNSW index for the configured dimension.
    embedding    vector,
    -- Version tracking through a soft delete: when a document updates, the old chunks
    -- get a superseded_at timestamp instead of being deleted. This keeps fact_evidence
    -- references intact and lets the system replay the earlier text. Setting this
    -- timestamp also clears the embedding, because a superseded chunk takes no part in search.
    doc_version   INT NOT NULL DEFAULT 1,
    superseded_at TIMESTAMPTZ,
    -- The timestamp for completed graph extraction. When a document updates, an unchanged
    -- chunk that already carries this timestamp is claimed and skipped during re-extraction
    -- (incremental extraction). This also lets an interrupted extraction resume where it left off.
    extracted_at  TIMESTAMPTZ,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX chunks_document_idx ON chunks (document_id, seq);
CREATE INDEX chunks_kb_idx ON chunks (kb_id);
CREATE INDEX chunks_live_idx ON chunks (document_id) WHERE superseded_at IS NULL;


CREATE UNIQUE INDEX documents_source_key_idx
    ON documents (source_id, external_key) WHERE external_key IS NOT NULL;

-- The raw material for version replay. Files are content-addressed and never deleted.
CREATE TABLE document_versions (
    id          UUID PRIMARY KEY,
    document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    version     INTEGER NOT NULL,
    sha256      TEXT NOT NULL,
    size_bytes  BIGINT NOT NULL DEFAULT 0,
    ingested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (document_id, version)
);

-- One row per sync (time, status, output, error): an auditable history of each channel.
-- Each source keeps only its 50 most recent rows; finish_run trims older rows.
CREATE TABLE source_sync_runs (
    id           UUID PRIMARY KEY,
    source_id    UUID NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
    started_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at  TIMESTAMPTZ,
    status       TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'ok', 'failed')),
    created_docs INTEGER NOT NULL DEFAULT 0,
    updated_docs INTEGER NOT NULL DEFAULT 0,
    error        TEXT
);
CREATE INDEX source_sync_runs_source_idx ON source_sync_runs (source_id, started_at DESC);

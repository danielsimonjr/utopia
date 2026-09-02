-- Data source grants: which workspaces may use a given data source.
--
-- **This layer did not exist before this migration.** Registering a source is a
-- deployment-level action, guarded by require_admin. But mounting it is guarded only by
-- require_kb(kb_id, Role::Admin), the admin of the requester's own knowledge base. The
-- list of mountable sources came from datasources::list(pool): every source in the whole
-- deployment, with no filter.
--
-- So the admin of any single knowledge base could list every registered data source in
-- the deployment and mount any of them into their own base. Once mounted, every viewer of
-- that base could run a read-only query against it through query_data (Ask-the-Data
-- allows read access, and a viewer role can use it). In a multi-workspace deployment,
-- this crosses tenant boundaries.
--
-- **Why this is a new table, instead of adding a workspace_id column to data_sources:**
-- a single workspace_id column would mean each data source belongs to only one
-- workspace. In a company with one data warehouse and several departments each in their
-- own workspace, that warehouse could then serve only one department; a relationship that
-- should be many-to-many would collapse into one-to-many. A grant is inherently
-- many-to-many: one source can be granted to several workspaces, and one workspace can
-- hold grants to several sources.
--
-- **How this table divides responsibility with kb_data_sources** (which keeps every one
-- of its own columns unchanged):
--
--   grant  = a system administrator says "this source may serve these workspaces" <- this table
--   mount  = a knowledge base admin says "my base mounts these sources"            <- kb_data_sources
--
-- Both layers are many-to-many, and each has its own owner. A mount can no longer happen
-- on its own; it can only choose from the set of sources already granted.
CREATE TABLE data_source_grants (
    data_source_id UUID NOT NULL REFERENCES data_sources(id) ON DELETE CASCADE,
    workspace_id   UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    granted_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- The user who created this grant. **This foreign key has no ON DELETE rule**,
    -- matching entity_merges.merged_by and the other columns like it: a user account is
    -- deactivated, not deleted; the production code has no DELETE FROM users statement,
    -- so attribution stays intact.
    granted_by     UUID REFERENCES users(id),
    PRIMARY KEY (data_source_id, workspace_id)
);

-- "Which sources can this workspace use" is a hot-path query, asked every time the data
-- mapping page opens. The primary key already covers the reverse lookup, "who has a
-- grant to this source."
CREATE INDEX data_source_grants_workspace_idx ON data_source_grants (workspace_id);

-- Backfill existing mounts: without this step, this migration would cut off every source
-- currently in use the moment it runs.
--
-- **This backfill only records what is already true; it does not add a permissive
-- default.** It grants access only to the workspaces that had **already mounted** a
-- given source. A workspace that never mounted a source gets no grant for it; blocking
-- exactly that case is the point of this migration.
INSERT INTO data_source_grants (data_source_id, workspace_id)
SELECT DISTINCT kds.data_source_id, kb.workspace_id
  FROM kb_data_sources kds
  JOIN knowledge_bases kb ON kb.id = kds.kb_id
ON CONFLICT DO NOTHING;

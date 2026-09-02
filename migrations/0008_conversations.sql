-- Chat session storage: conversations, messages, action traces, and citations are stored
-- alongside each message.
-- The server assembles context from this data (the frontend sends only conversation_id
-- and the new message). steps and sources use the same shape as the live SSE events, so
-- history replay and streaming rendering share one set of components.

CREATE TABLE conversations (
    id         UUID PRIMARY KEY,
    kb_id      UUID NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
    user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title      TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX conversations_kb_user_idx ON conversations (kb_id, user_id, updated_at DESC);

CREATE TABLE conversation_messages (
    id              UUID PRIMARY KEY,
    conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    role            TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    content         TEXT NOT NULL,
    -- The action trace (tool call steps) and the citation list, for history replay. Both
    -- use the same shape as the live SSE step and sources events.
    steps           JSONB NOT NULL DEFAULT '[]',
    sources         JSONB NOT NULL DEFAULT '[]',
    -- The entities this turn resolved (id, name, type), replayed on the next turn.
    -- **This column does not replay the full tool result.** A tool result holds raw chunk
    -- text, and repeating that on every turn would fill the context window within a few
    -- turns. What needs replaying is identity: with an id in hand, the next turn can call
    -- entity_facts directly, without a fresh name lookup. This also fixes a subtler
    -- problem: when a name is ambiguous, two turns could otherwise resolve it to two
    -- different entities, and the two answers would then describe different nodes
    -- without anyone noticing.
    resolved        JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX conversation_messages_conv_idx
    ON conversation_messages (conversation_id, created_at);

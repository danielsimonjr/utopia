-- What the assistant **did** on its last turn, not only what it said at the end.
--
-- This started as a bug that looked like a prompt problem: a user said "translate" right
-- after a previous turn, and the assistant re-ran the whole tool sequence again. Because
-- eight entities shared the same name, the second run landed on a different batch of
-- them: the user wanted the same passage in a different language, and got a different
-- passage instead.
--
-- The real cause was not the prompt. conversations::recent_context returned only (role,
-- content). Within one turn, the model can see its own tool calls (those messages are
-- still in msgs), but **that history is gone across turns**, leaving only the prose the
-- model wrote at the end. On the next turn, the model has no way to know it already ran
-- that lookup, so running it again is the most reasonable guess it can make. Fighting a
-- correct guess like this with a prompt instruction wins only part of the time: three out of four tries, in testing.
--
-- So the tool history must not be lost. This column stores the full trailing set of
-- messages for that turn — the assistant message carrying tool_calls, plus the matching
-- tool result messages — and sends them back unchanged on replay.
ALTER TABLE conversation_messages
    -- Shaped like `[{"role":"assistant","tool_calls":[...]}, {"role":"tool","tool_call_id":...}, ...]`.
    --
    -- **This stores the already-truncated version.** A tool result is truncated to
    -- TOOL_CHUNK_CHARS before it is sent to the model, and this column stores that same
    -- truncated copy, not the original response. Storing the original would make replay
    -- take up more space than the turn did the first time.
    --
    -- This column has meaning only on an assistant row; a user row always holds an empty array.
    ADD COLUMN tool_exchange JSONB NOT NULL DEFAULT '[]'::jsonb;

-- **Only the most recent turn gets replayed.** This column exists so the model knows
-- "what I just did," not so twenty turns of tool output get carried back into context —
-- that exact cost is why only the final text was stored in the first place. So this
-- column has no index: a query here already carries conversation_id and a time order.
COMMENT ON COLUMN conversation_messages.tool_exchange IS
    'The assistant turn''s tool calls and their results, replayed for the most recent turn so the model knows what it already did.';

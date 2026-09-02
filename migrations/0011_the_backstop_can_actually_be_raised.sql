-- The outer backstop's upper limit was exactly equal to its own default, so it could
-- never actually be raised.
--
-- The design for `worker_concurrency` is written in a comment in migration 0001: **this
-- is an outer backstop, not the main throttle.** The main throttle is the per-model
-- semaphore, and the backstop must be "well above the sum of the per-model limits;
-- otherwise, a throttled job can fill every worker slot and starve every other job."
--
-- But the constraint was `BETWEEN 1 AND 32`, and the default was also 32: **the
-- constraint blocked the design it was meant to support.** This happened in two steps:
-- the constraint was written when the default was still 4 (so 32 gave eight times
-- headroom at the time), and later the default rose to 32 with no one revisiting that
-- constraint. The validation on the application side was updated to `1..=256`, so the two
-- sides disagreed: setting any value from 33 to 256 on the settings page passed the
-- application's check and failed the database's, and the user saw a raw CHECK constraint
-- error instead of a clear "out of range" message.
--
-- This migration raises the upper limit to 256, matching the application-side check.
--
-- **This migration also raises the default to 64.** The scenario the earlier comment
-- warned about ("otherwise it starves everything else") happened in practice: during an
-- extraction run over 219 documents, 32 extract_document jobs filled every worker slot,
-- and embed_ontology sat queued with no slot free. 32 was only 3.2 times the model limit
-- of 10, so an extraction run alone could jam the whole queue.
--
-- Why 64 and not a larger value: a job waiting on the semaphore costs almost nothing (it
-- holds no connection, since the extraction path holds no transaction across an await),
-- but **before it reaches the semaphore**, each chunk still does two database-bound
-- steps: one lookup of extract_epoch, and, for a large ontology, one vector search
-- against every relation and class. Neither step is limited by the model semaphore. So
-- worker concurrency directly sets how many of these lookups hit the database at once,
-- against a pool of 32 connections. 64 is twice that pool size, which still lands on the
-- "gets slower" side rather than the "times out" side. Going higher than that should wait
-- for a separate change: moving the semaphore acquisition to the very start of each
-- chunk's work, so a queued slot truly costs close to nothing.
--
-- This migration changes only the deployments still holding the old default of 32. A
-- deployment where someone already set a different value keeps that value, following the
-- same rule used for the earlier change from 4 to 32.

ALTER TABLE deployment_settings
    DROP CONSTRAINT IF EXISTS deployment_settings_worker_concurrency_check;

ALTER TABLE deployment_settings
    ADD CONSTRAINT deployment_settings_worker_concurrency_check
    CHECK (worker_concurrency BETWEEN 1 AND 256);

ALTER TABLE deployment_settings
    ALTER COLUMN worker_concurrency SET DEFAULT 64;

UPDATE deployment_settings SET worker_concurrency = 64 WHERE worker_concurrency = 32;

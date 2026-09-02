# Benchmark harness for entity resolution

**Use a new knowledge base for each run.** This rule is the reason this directory exists.

A past test ran three rounds of retrieval tuning on the same knowledge base. That base still held the type changes from the earlier rounds. The easy entities were already refined. Their rejection reasons already said `already correctly typed as pharmacy`. The numbers from the later rounds could not compare to the first round. The team used those numbers to change code twice anyway. Reusing a base saved a few minutes. It also produced a set of invalid conclusions.

## Run a test

```
node scripts/bench/run.mjs --corpus pharma --label seeds-only
node scripts/bench/run.mjs --corpus pharma --ontology /tmp/schemaorg.ttl --label schemaorg
```

Before you run a test:
1. Start `utopia-server`.
2. Connect it to a knowledge base you can write to.
3. Set the chat model and the embedding model for the workspace.

`run.mjs` lists the environment variables at the top of the file.

## Directory contents

- `corpora/*.json` — fixed test text. **The same entity appears across several documents on purpose.** A corpus with one document per entity gives each entity only one or two facts. Its profile is close to a bare name. That is not enough to measure resolution quality.
- `truth/*.json` — the expected class for each entity. Each key is a short piece of the entity's name, enough to identify it. Extraction gives a slightly different name each time, so an exact match would count that variation as a failure. Each value lists the classes the system may return; any match in the list counts as correct. **An empty array means the ontology has no matching class. The correct action then is to leave the entity alone.**
- `run.mjs` — runs one test: create a base, load the corpus, import an ontology if given, run resolution, and score the result.
- `fetch-ai-timeline.mjs` — fetches the **current version** of an article (`prop=extracts`).
- `fetch-wiki-history.mjs` — fetches **historical snapshots** of an article (`action=parse&oldid`). Use this script to test change over time. Load several snapshots of the same article by their `doc_time`, and the graph changes its own understanding.
- `subset-corpus.mjs` — picks a few articles from a corpus and builds a new corpus from them. It takes **whole articles**, because `supersedes` links only connect adjacent snapshots of the same article. A random sample of pieces would remove the time axis from the test.
- `subset.mjs` — cuts a schema.org TTL file down to its first N classes, for scaling tests.

## How the score works

- `prompt_tokens_est` estimates the size of the **ontology section** of the prompt. It is not the size of the whole prompt. In tests, about 4.0 characters equal 1 token (measured at 377,735 characters to 81,855 tokens, and 396,716 to 99,041). The real token count lives inside the LLM client, and exposing it would need a change to several function signatures. This script only needs to track ontology size, and the ratio stays stable enough for that.
- `for_review` items count as a miss. The system has not corrected them yet. Counting them as a hit would credit the system for work a person still has to do.
- `absent` marks a case where the truth file lists an entity, but extraction never produced it. This is not a resolution error. It gets its own column.

## The truth file can be wrong

In an early run, one truth entry was too narrow. It listed only `business_event|event_series` for `Cardiovascular Health Forum`. The system's answer, `conference_event`, was correct. **When an answer is wrong, fix the answer.** Fix it only after you see the result, and write down why. Otherwise the truth file stops measuring anything. It becomes a record of what the system answered that time.

## Add a corpus

Add two files: `corpora/x.json` and `truth/x.json`. Use a corpus from a new industry on purpose. The same resolution logic must hold across two different domains. That is how you know it is not overfit to one set of words.

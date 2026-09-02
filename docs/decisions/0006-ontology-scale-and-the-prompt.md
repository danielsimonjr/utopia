# 0006 · Ontology scale and the extraction prompt

- **Status**: Shipped. The budget (24,000 characters) and per-chunk retrieval are live; the numbers are unchanged. The "seed base types always present" floor is replaced by **ancestor backfill** (see the revision at the end). The exact budget numbers still need a better corpus to set them — an external corpus is now in the repository, but its answer key is still filled in by hand (checked 2026-09-02).
- **Written**: 2026-08-29 (see conventions in [README](README.md))

> This document has one thing the others do not: **numbers.** They come from `scripts/bench/`, and anyone can re-run them.
> Each number is marked with what it **cannot** show — the difference between two runs is often just run-to-run variance, and mistaking variance for a real effect is a mistake made more than once in this round of work.

## The problem

The extraction prompt lists **the whole ontology**, resent for every text chunk. `extraction.rs` used to have one line, `entity_types(kb)`, with no filter at all.

After importing the current release of schema.org: 968 types, 1,034 relations, 599 attributes, **108,133 tokens per text chunk.** This number is not the cost of a design choice — **it is the result of having no design at all**; the code has no "choose" step anywhere. [0001](0001-ontology-import-and-governance.md) P3 once filed this under "the prompt explodes at 800 types," but no one had measured a real ontology yet, and it guessed the wrong culprit: the type list is only 38% of the prompt; relations are 34%, attributes 28%.

## The decision

**Switch by budget, not by type count.**

- Fits the budget → list everything, behavior unchanged. A 40-type ontology costs about 2k characters; retrieval there would only add an unneeded round trip.
- Exceeds the budget → **retrieve candidates per chunk using that chunk's own vector**, with seed types always present (later replaced by ancestor backfill, see the end of this document); fall back to listing everything if retrieval finds nothing.

The budget counts **characters, not type count**: type description length varies by orders of magnitude (a `SoftwareApplication` description is one sentence; a FIBO one can run a full paragraph). The check measures **the actual text about to be listed** (`build_lists` counts it directly), instead of a separate estimation formula that would drift out of sync with the real layout.

The chunk vector is **already available** — `chunk.embedding` is already loaded inside the extraction loop (entity resolution uses it), so per-chunk retrieval adds zero extra embedding calls.

The budget lives in `deployment_settings.ontology_prompt_budget`, not as a constant or an environment variable, because of the measurement process itself: tuning it needs paired comparisons at each setting, and if changing a setting requires a service restart, no one will ever run that comparison a second time.

### Three details that only matter once "choosing" exists

1. **A signature can only mention a type that is listed.** In `works_at (person → organization)`, both keys must be types the model can actually see — naming a type that was left out teaches the model to output a type that does not exist. If neither side is selected, the signature falls back to `*`.
2. **Attributes follow their domain.** An attribute line reads `class.attr`; if its type is not listed, the line means nothing. This also solves trimming the attribute section (28% of the prompt) with no separate handling needed.
3. **Both paths share one `build_lists` function.** Two separate layout implementations would eventually drift apart, and drifting here means the prompt states one thing while the code trusts another.

## What we measured

Same corpus (`scripts/bench/corpora/pharma.json`, 5 Chinese pharmaceutical documents), **a fresh base per group**, importing the ontology before loading the text (so extraction sees the ontology from the start).

| Inline types | Ontology section, characters | Mode | Entities / facts extracted | Extraction, seconds |
|---|---|---|---|---|
| 32 | 2,977 | Full list | 23 / 25 | 47 |
| 32 | 2,977 | Retrieval | 28 / 27 | 31 |
| 78 | 19,187 | Full list | 25 / 26 | 41 |
| 78 | 19,187 | Retrieval | 23 / 26 | 36 |
| 202 | 58,651 | Full list | 26 / 27 | 36 |
| 202 | 58,651 | Retrieval | 23 / 26 | 36 |
| 394 | 169,380 | Full list | **Did not finish (429, rate limit)** | — |
| 394 | 169,380 | Retrieval | 28 / 26 | 52 |

**First: no degradation shows up up to 58,651 characters (about 15k tokens).** Entity count moves between 23 and 28 with no trend. This does not match the intuition that a large prompt loses facts, and it does not match an earlier conclusion of ours either (see the retraction below). So the current 24,000-character budget is **likely conservative**, but changing it needs a better corpus first.

**Second: listing everything in full has a hard ceiling unrelated to quality.** At 400 types, the full-list group hit the vendor's per-minute token limit (429); the retrieval group on the same ontology completed normally. This is not "slower" — it is **does not finish at all.**

**Third: a large ontology does deliver correct types, but only when retrieval brings them into view.** A separate comparison (schema.org in full, 968 types): with only the seed ontology, 2 of 19 entities had the correct type; with the large ontology used only for after-the-fact resolution, 7; with the large ontology plus per-chunk retrieval in the prompt, 12.

## What these numbers cannot show

- **Each configuration ran only once.** With the same input and the same settings, we have separately observed runs differing between 25 and 18 entities. So a single-digit difference in the entity-count column **carries no information** — only a trend, or the absence of one, is readable.
- **The type subset was taken in alphabetical order.** `subset.mjs` takes the first N types, so the 200-type row contains only types starting with A–B (`AdultEntertainment`, `Brand`, and so on), and none of `hospital`, `pharmacy`, `drug`, or `city`. **This is why the table above has no hit-rate column**: the correct answers were not even in the subset, so a low hit rate here would not be the system's fault. Measuring "how vocabulary size affects quality" needs a subset sampled from types that actually appear in the corpus.
- **We wrote the corpus and filled in the answer key ourselves.** The corpus, the answers, and the system under test all came from the same hand, so overfitting cannot be ruled out. This is the biggest weakness today; see below.

## Open

**Whether the corpus is valid.** Both corpora today (tech and pharma) are hand-written, with an answer key filled in line by line. They are good enough as smoke fixtures — offline, fast, deterministic — but **not enough to support a claim like "this change is better,"** and an outside contributor has no way to compare results against them either.

The plan is to add an external corpus where **the answer key is derived from outside data, not filled in by us**: Chinese Wikipedia article text (CC BY-SA, usable and citable) paired with Wikidata's `P31` as the type answer. The point is not that Wikipedia is "more realistic" — it is encyclopedic prose, unlike enterprise documents — the point is that **the answer stops being our own opinion.** The generation script must be committed alongside it, or "which articles were picked" becomes another unreviewable choice.

**The exact values for the budget and per-chunk candidate counts.** 24,000 characters, and 40 types / 30 relations / 30 attributes per chunk, are all guesses, marked as such in the code. The curve above suggests they are conservative, but tuning against that curve before a real corpus exists would only overfit more tightly.

## Revision note (2026-09-02): the floor changed material, and the index has a real cost

**"Seed types always present" stopped working.** It assumed the seed types were exactly those few general-purpose types, but after #128 a new base seeds no types at all, so `seed_classes` is always empty. The symptom was measured in [0012](0012-the-ontology-is-a-contract-not-a-suggestion.md): vector retrieval favors leaf types that appear literally in the source text (out of 976 types, `researcher` ranked 4th and `corporation` 27th, while `organization` ranked 177th and `person` 359th — not one general-purpose base type made the top 40). So an entity was typed as `researcher`, and the `employee (organization → person)` signature degraded to `(* → *)`.

**Fix: whatever type is retrieved, also list its ancestors.** Walk up `subClassOf`, breadth-first with a visited set (diamond inheritance can reach the same ancestor by two paths). This is better than maintaining a hand-picked list of "general types" — the class hierarchy is already the ontology's own declared generalization relation; there is no need to re-decide who outranks whom. The cost is a few extra ancestor entries per chunk. This is a fourth detail, beyond the three listed above, and the only one forced out by real data.

**The ontology vector index itself has two more measured constants**, not covered by this document's original focus on prompt size: `BATCH = 64` (once changed to 16, because measuring "faster per item" on short synthetic text looked better; reverted after doubling real throughput) and `EMBED_JOBS = 4` (once run through `join_all` across all 31 batches at once, which starved the shared `model_concurrency` limit — five documents got stuck entirely on embedding, with extraction making zero progress for fifteen minutes). A stale index self-heals by checking whether the originally embedded text and model name still match today; it uses no explicit invalidation hook.

**The system-level cost of per-chunk retrieval**: one vector query against the database per chunk, at a concurrency set by `worker_concurrency`, whose ceiling was raised from 32 to 256 (#133). The connection pool stays at 32. This document did not record that cost; the comment in migration `0011` does.

**The benchmark tooling can now test the open question from 0008**: `run.mjs --packs schema-org,prov-o` follows the product's real cold-start path. The tool is ready; the comparison has not been run yet.

**The corpus side**: the corpus count grew from 2 to 8; none of the new ones are hand-written (a Wikipedia history snapshot with a reproducible manifest, public-domain State of the Union speeches, and Sherlock Holmes stories), with the generation scripts committed alongside them. But "answer key derived from outside data" is not done — `scripts/bench/truth/` still holds only the two hand-filled pharma and tech answer keys, with no Wikidata `P31` data anywhere.

## Retraction

> **"The 108k-token prompt cost 5 entities" does not hold.** That conclusion came from the benchmark tool's default order (load the corpus, then import the ontology), so both extraction runs actually saw only the 9 seed types in the prompt — `prompt_tokens_est` was measuring the ontology **after** import, which extraction never saw. The 25-vs-18 difference was run-to-run variance.
>
> The tool did not catch this mistake at the time, because the metric's name implied an ordering that the run never actually followed. Now the two ontology sizes are reported separately (`ontology_at_extraction` / `ontology_at_resolution`), and a `--ontology-first` flag exists; the order is stated in the output instead of relying on someone remembering it.

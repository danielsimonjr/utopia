# 0004 · Language: what follows the reader, what follows the source text

- **Status**: Shipped. L0 through L3 are all live: UI vocabulary lives in `web/src/i18n/` (about 950 strings, including 108 functions); server errors changed to `AppError::Invalid` with a `code` (81 places; 23 places keep English `Validation` on purpose, as an API contract guard); ontology `description` follows `knowledge_bases.ontology_lang` (with a deployment-level default); LLM output written for a person uses the `locale` the caller passes in the request; extracted data always matches the source document, word for word. **Two points differ from this document**, see the 2026-09-02 revision: the UI deliberately does not guess the browser language on first visit; the "Chinese built-in ontology" branch is retired along with seeding.
- **Written**: 2026-08-29 (status corrected 2026-08-30: the document said "planned" while the index and the code both said "shipped"; reviewed again against the code on 2026-09-02).
- **Related**: [0001](0001-ontology-import-and-governance.md) argues that `description` is load-bearing; this document adds which language it should be in. [0003](0003-ontology-growth-loop.md)'s split between `reason` and `description` is the starting point for the boundary drawn here.

> Trigger: the product needs a Chinese-language edition for Chinese enterprises. But "add a language switch" hides **five different kinds of text**, each with a different correct language. One switch for all five is guaranteed to be wrong for at least some of them.

---

## Five kinds of text

People usually call all of this "copy," but the reader and the source differ for each:

| | Example | Reader | Source |
|---|---|---|---|
| **UI vocabulary** | "Import an ontology" | A person | Hardcoded in `i18n.ts` |
| **Server errors** | "Password must be at least 8 characters" | A person | Hardcoded in Rust |
| **Ontology label / description** | `person` / "A named individual human being…" | **The description's reader is the model** | Built-in seed, user-written, or OWL import |
| **LLM text generated live, for a person to read** | A suggestion's `reason` | A person | The model, generated on demand |
| **Extracted data** | An entity name like "Zhang San," a `surface_predicate` like "runs on" | Both a person and the model | **The source text, word for word** |

The last row is not copy. **It is a quotation.**

---

## Where the boundary falls

### UI vocabulary → the client decides, one person at a time

The same category as dark mode: this is a preference of **the reader**, not a property of the deployment. A foreign colleague at a Chinese company should not need an administrator's help just to see the English UI.

Use `localStorage` and the existing `makeStore` pattern from [wsStore.ts:22](../../web/src/wsStore.ts), adding one line: `makeStore("utopia.lang")`. Guess once from `navigator.language` on first visit; after that, use what the person picked.

> **Revision note (2026-09-02)**: guessing once from `navigator.language` **was not shipped, on purpose.**
> `web/src/i18n/index.ts`'s `detect()` reads only `localStorage`, and falls back to `"en"` otherwise. The code comment states: "add the `navigator.language` line back once the Chinese pack catches up." The reason is the first item under "known pain points" below: the Chinese pack lags the English pack, and a missing translation silently falls back to English. This trades "the two packs can drift apart" for "a Chinese-speaking user sees English by default" — a deliberate choice, not an oversight. Add the line back once the packs match.

> **Revision note**: the first draft of this document put UI language in **deployment-level admin settings**, reasoning "same as the connection pool limit — store it in the database, apply it right away." That comparison was wrong. The pool limit is **a property of the deployment** (a vendor rate limit); UI language is **a property of the reader**. The right question for any setting is not "how easy is this to change," it is "who does this describe."

Write the Chinese pack as `const zh: typeof S = { … }`. **Do not use `Partial` with a per-key fallback** — that lets a missing translation fail silently, quietly showing English on one line, and only a user would ever notice. `typeof S` makes a missing entry a compile error instead — with 512 strings and 44 functions, no person can check that alignment by eye.

### Server errors → convert to a key; wording belongs to the frontend

Once UI language lives on the client, **the backend no longer holds any locale.** A string left in Rust is **permanently untranslatable**, not "translate it later."

`AppError::Validation` had 75 uses. (**Now done**, checked 2026-09-02: every reachable case became `AppError::Invalid` with a `code`, 81 places, matched by 48 entries in the frontend `err.*` table. The remaining 23 `Validation` cases are all API contract guards. `Invalid` also carries a separate `detail` field, keeping machine-supplied detail — like a cron parser's error — apart from the wording; `message` stays as the original English sentence on purpose, for clients that do not localize, such as MCP and the CLI, and for logs.) Split into two groups:

- **Errors a normal user can hit** (a password rule, an email format, an empty file, a date format) → convert to a key, looked up on the frontend. This keeps all wording in one file, `i18n.ts`, instead of split half on the frontend and half on the backend.
- **API contract guards** (`role must be admin, editor or viewer` — reachable only by calling the wrong endpoint) → keep in English. Its reader is a developer, and staying in English forever is exactly right for it.

The key point is to **decide each case explicitly**, not to leave it as a vague "we'll handle it later."

> This turns an existing rule in this codebase from good practice into a hard requirement: **the server must not produce display text.** Breaking this rule used to be only inelegant (OWL import once put `（手工建的）` into `conflict_with`, leaking straight into the English UI). Breaking it now means creating a string that can never be translated.

### Ontology description → follows the source text, not the UI

`description` goes word for word into the extraction prompt ([0001](0001-ontology-import-and-governance.md) already established it is load-bearing). **Its reader is the model, and the model is reading your documents.**

So its correct language is **the language of the source text**, not the language of the UI. A Chinese company reading English technical documents is a common pairing: the UI should be Chinese, while the type descriptions **should be English** — a description in the same language as the text being judged gives the model a more reliable answer to "does this text describe a `product`."

This is a **knowledge-base-level** property (one base holds one body of text), not a deployment-level or a client-level one.

### Ontology label → data, tied to no switch at all

`label` is stored in the base and cannot follow a client-side switch. **This is correct.** It is the ontology a specific team wrote. If a Chinese team names a type `人物`, a colleague using the English UI should still see `人物` — it is a concept their colleague defined, not a UI element. Translating it would be the actual mistake.

The 9 built-in types were application vocabulary only **at the moment of seeding**; once stored, they became that base's own data, editable like anything else. (**Now obsolete**: after [0009](0009-no-type-is-a-type.md), [0010](0010-no-relation-is-no-relation.md), #125, and #128, there are no built-in types, no seed relations, and no seeding function left. Cold start now comes from an English-language ontology pack ([0008](0008-ontology-packs-as-cold-start.md)) instead. The practical effect of "label is data" is now: **a Chinese-language base installs a purely English ontology**, and `ontology_lang = zh` affects only vocabulary grown later through LLM proposals. See the open questions in 0008.)

**`key` is never translated.** It is an identifier (`[a-z0-9_]`, at most 40 characters), a token the model reads and writes, and the lookup key for `type_ids`.

**One related fix**: the prompt used to lay out each line as `- {key} ({label}): {description}` ([lib.rs](../../crates/utopia-extract/src/lib.rs), since changed as described next). When the UI language and the source language differ, this line mixes English and Chinese mid-sentence. Since `Person` carries almost no extra information over `person`, **the prompt now sends only `key` and `description`; `label` is used only when `description` is empty.**

### LLM text generated live, for a person → the caller states the language in the request

`reason` is generated live when a person clicks "Suggest with AI," shown once, and gone once accepted or dismissed — `suggest` **returns immediately and is not stored** ([ontology_routes.rs](../../crates/utopia-server/src/api/ontology_routes.rs)). Since the caller is present at that moment, the request itself should state the wanted language, instead of the backend keeping a stored setting.

> **Revision note (2026-09-02)**: "not stored" **no longer holds** — after #112, a completed `suggest` call writes into `ontology_proposals`, since what gets lost is not the raw material but **the clustering result** (see the known gap in [0003](0003-ontology-growth-loop.md)).
> The language conclusion is unchanged: `reason` still generates using the request's `locale`, while label and description still follow `kb.ontology_lang` — both are expressed in **the same call**, and the prompt states explicitly that the latter overrides the English scaffold.

Automatic cold-start ontology growth follows the same path but has no human caller. Its generated `reason` was already discarded (`lastAutoExtension` only returns relations, classes, facts_remapped, and batches counts), so that path needs no locale at all.

**The real bug today is not a wrong language, it is no stated language at all**: the prompt in [bootstrap_ontology.rs](../../crates/utopia-server/src/bootstrap_ontology.rs) never states an output language, so the model picks one on its own. (**Fixed**: the prompt now ends with a full Language instruction block; `lang_name()` turns `zh` into the word "Chinese" before sending it — the model recognizes "Chinese" reliably, but not necessarily the code `zh`. Cold start explicitly passes `en`.)

### Extracted data → matches the document, word for word, with no switch at all

An entity is named "张三" because paragraph 3 of the document says so — the evidence chain points at that exact spot. Translating it to "Zhang San" breaks three things at once: the evidence no longer matches the source text, the same person splits into two entities across a Chinese and an English document, and the whole `surface_predicate` record of "what word the source actually used" loses its meaning.

**This is not a language preference. It is a question of provenance.**

---

## So the backend keeps exactly one language concept

| Layer | Controls | Stored where |
|---|---|---|
| Client | UI vocabulary (512 strings, 44 functions) | `localStorage` |
| Single request | LLM text generated live for a person | Request parameter |
| **Knowledge base** | `description`, which built-in ontology was seeded | One column on `knowledge_bases` |
| Deployment | The default for the row above | Admin settings |

The last row is the only thing left of "system language." It is worth keeping — a Chinese deployment should not have to pick a language by hand every time it creates a base — but **it needs a different name.** Calling it "system language" guarantees that someone, three months from now, will try to hang UI language off it and find that it does not fit. Calling it **"default ontology language for new knowledge bases"** rules out that mistake by name alone.

---

## One architectural rule

Locale must be **resolved in exactly one function**; everything else consumes that result instead of reading its own source.

This way, adding "per-user language," "follow the browser," or "switch UI by knowledge base" later means changing that one function, not searching through 512 call sites. **Where a setting is stored can change; having one place that resolves it will not.**

---

## Steps

| | Content | Depends on |
|---|---|---|
| **L0** | Frontend i18n scaffold: a locale store, a language switch, `zh.ts` (fully typed as `typeof S`) | None |
| **L1** | Classify server error text; convert reachable cases to keys | L0 |
| **L2** | Add a knowledge-base ontology-language column, a Chinese built-in ontology, a deployment-level default | None (can run alongside L0) |
| **L3** | Drop `label` from the prompt; pass locale to `suggest`; pin the output language in the prompt | L0 (source of locale) |

**L2 does not depend on UI language, and pays off today**: pairing Chinese source text with Chinese type descriptions improves extraction quality right away, with no need to wait for a Chinese UI.

**The most substantial part of L2 is not adding a column, it is rewriting the built-in ontology's descriptions** — 9 types and 14 relations. They were written carefully the first time, especially the negative examples ("not a role, a position, or a team — those belong to concept or organization" — errors cluster at boundaries, and the negative examples are the half doing the real work). **A translation cannot be a shortcut here; it needs the same care, rewritten in Chinese.**

> **Revision note (2026-09-02)**: this item **no longer has a target** — the seed ontology is retired entirely (see the obsolete note under "label" above).
> L0, L1, L3, and the "add a column plus a deployment default" part of L2 are all shipped. The Chinese-ontology idea took a different shape instead: a user imports their own Chinese vocabulary, or waits for an ontology pack with Chinese labels (an 0008 open question). There is no third path in the code.

---

## Known pain points

- **The Chinese and English packs can drift apart.** `typeof S` blocks a missing entry, but it cannot block "the English wording changed and the Chinese did not" — both states compile cleanly. There is no good fix yet; the only defense is updating both files at the same time.
- **A base holding a mix of Chinese and English documents** has no single correct language for `description`. This document chose "one language per knowledge base," since mixing languages already lowers extraction quality on its own, beyond just the description question. Revisit this if it becomes a real problem; do not design for it in advance.
- **Chinese tokenization and search.** Tantivy already uses `tantivy-jieba`, outside the scope of this document, but the Chinese edition will put it under real scrutiny.
- **(Added 2026-09-02) While the Chinese pack lags the English pack, the UI defaults to English.** See the revision note under "UI vocabulary": `detect()` does not guess the browser language for now. The signal to add `navigator.language` back is when `zh.ts` needs nothing beyond `typeof S` to stay correct.

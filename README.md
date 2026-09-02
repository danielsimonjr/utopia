<div align="center">

<img src="assets/banner.webp" alt="Utopia" width="820">

</div>

# Utopia

<div align="center">

[Philosophy](#philosophy) · [Quick start](#quick-start) · [Features](#features) · [Roadmap](#roadmap)

[![Stars](https://img.shields.io/github/stars/deeplethe/utopia?style=flat-square&label=STARS&labelColor=161B22&color=FFC220&logo=github&logoColor=FFFFFF)](https://github.com/deeplethe/utopia/stargazers)
[![License](https://img.shields.io/badge/LICENSE-APACHE%202.0-3FB950?style=flat-square&labelColor=161B22)](LICENSE)
[![Bun](https://img.shields.io/badge/BUILT%20WITH-BUN%20%2B%20TYPESCRIPT-F9F1E1?style=flat-square&labelColor=161B22&logo=bun&logoColor=FFFFFF)](https://bun.sh)

[![Official site](https://img.shields.io/badge/OFFICIAL-UTOPIA.BI-FFFFFF?style=flat-square&labelColor=161B22&logo=safari&logoColor=FFFFFF)](https://utopia.bi)
[![Container](https://img.shields.io/badge/GHCR-DEEPLETHE%2FUTOPIA-2496ED?style=flat-square&labelColor=161B22&logo=docker&logoColor=FFFFFF)](https://github.com/deeplethe/utopia/pkgs/container/utopia)
[![Discussions](https://img.shields.io/badge/DISCUSSIONS-8957E5?style=flat-square&labelColor=161B22&logo=data:image/svg%2Bxml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxNiIgaGVpZ2h0PSIxNiIgZmlsbD0iI0ZGRkZGRiIgY2xhc3M9ImJpIGJpLWNoYXQtZG90cy1maWxsIiB2aWV3Qm94PSIwIDAgMTYgMTYiPgogIDxwYXRoIGQ9Ik0xNiA4YzAgMy44NjYtMy41ODIgNy04IDdhOSA5IDAgMCAxLTIuMzQ3LS4zMDZjLS41ODQuMjk2LTEuOTI1Ljg2NC00LjE4MSAxLjIzNC0uMi4wMzItLjM1Mi0uMTc2LS4yNzMtLjM2Mi4zNTQtLjgzNi42NzQtMS45NS43Ny0yLjk2NkMuNzQ0IDExLjM3IDAgOS43NiAwIDhjMC0zLjg2NiAzLjU4Mi03IDgtN3M4IDMuMTM0IDggN001IDhhMSAxIDAgMSAwLTIgMCAxIDEgMCAwIDAgMiAwbTQgMGExIDEgMCAxIDAtMiAwIDEgMSAwIDAgMCAyIDBtMyAxYTEgMSAwIDEgMCAwLTIgMSAxIDAgMCAwIDAgMiIvPgo8L3N2Zz4%3D)](https://github.com/deeplethe/utopia/discussions)
[![Built by DeepLethe](https://img.shields.io/badge/BUILT%20BY-DEEPLETHE-2D333B?style=flat-square&labelColor=161B22)](https://github.com/deeplethe)
[![中文](https://img.shields.io/badge/LANG-%E4%B8%AD%E6%96%87-DA3633?style=flat-square&labelColor=161B22)](README.zh-CN.md)

</div>

**Utopia is the enterprise world model built by [DeepLethe](https://deeplethe.com).** It is an open substrate for knowledge engineering. It learns from new material without manual effort, and it governs its own vocabulary. A knowledge graph or a vector store holds present knowledge. Utopia adds two things at its base layer: time awareness and an ontology. The knowledge system evolves as new material arrives. Conflict detection, reasoning, and decision-making all run against the ontology. Utopia deploys offline. A company can run a knowledge foundation, a decision core its agents can trust, and a compliance audit trail on hardware it controls.

> Utopia is not an open-source take on Palantir. It takes **a different route to enterprise intelligence: build up from knowledge governance to trustworthy decisions and simulation.**

---

<!-- Video: drop an mp4 into any issue/PR comment box, GitHub returns a
     https://github.com/user-attachments/assets/xxx link,
     paste that link on its own line here and it renders as a player. -->

<div align="center">

https://github.com/user-attachments/assets/aa226443-75de-437e-bd80-88e592ed8457

</div>

---

## Philosophy

We named this project **Utopia**. For centuries, people took Ptolemy's geocentric model as fact. Copernicus, Kepler, Galileo, and Newton disproved it, step by step. Looking back, the interesting part is not only that heliocentrism was correct. The interesting part is how that understanding changed over time.

A vector store or a knowledge graph aims to get present knowledge right. Utopia has a different founding aim: record the whole course of changing understanding. In engineering terms, this becomes a **bitemporal knowledge graph**. When someone reviews a decision later, the system can show the full path it took and the evidence it rested on. We tested this design against public text from enterprise records, education, finance, law, and research. Time is only one part of the design. Read [utopia.bi/philosophy](https://utopia.bi/philosophy) for how Utopia takes in knowledge, reasons about the future, and bounds action with logic.

## Features

Utopia runs as a Bun and TypeScript server plus a Postgres service. pgvector and a queue-table design keep the stack and its dependencies light.

| | |
|---|---|
| **A complete application** | A system console, a graph browser, and an ontology workbench, all in the browser. Install it and use it. No library assembly required. |
| **Knowledge ingest** | Reads PDF, DOCX, PPTX, XLSX/XLS/ODS, CSV/TSV, Markdown, HTML, and plain text. Detects legacy text encodings on the way in. Syncs web pages, RSS, GitHub, and Jira on a schedule. Accepts other sources through a per-source push token. Reprocesses failed parses in place. Re-extracts a whole source or knowledge base in bulk. |
| **Search and chat** | Combines Tantivy full-text search and pgvector search, fused with RRF. Uses jieba tokenization for Chinese full-text search. Streams answers with inline citations that jump to the source passage. Works with any OpenAI-compatible endpoint (DeepSeek, Qwen, GLM, Ollama, vLLM), so the whole system can run on an isolated network. |
| **Agent harness and agentic RAG** | The application is itself a harness. You can drive the whole system through conversation. The built-in agent uses tools for document search, entity lookup, fact and change history, and querying a mounted database. It calls these tools over several turns before it answers. |
| **Ontology and cold start** | A new base ships with no vocabulary. Cold start comes from packs: schema.org, W3C Org, PROV-O, FOAF, and IOF Core. These packs ship inside the binary and you choose them at creation time ([ask for your industry](https://github.com/deeplethe/utopia/issues/new?labels=enhancement&title=Ontology%20pack%20request)). Utopia records vocabulary it meets outside the ontology, with a source quote and a count. Frequent items merge into the ontology on confirmation, so the ontology grows with the corpus. |
| **Bitemporal graph** | Extraction against the editable ontology produces entities and facts. Each fact carries a validity interval and its evidence rows. Correcting a fact closes the old version and links the new one to it. Utopia never overwrites a fact. Queries can read the graph as it stood at any point in history. The entity panel shows two timelines at once: when something held true in the world, and when the system changed its own understanding. |
| **Entity resolution and review** | Uses a three-stage entity resolution process. Every merge is logged and can be undone. Low-confidence extractions, merge candidates, and cardinality conflicts go to a review queue instead of interrupting a user. Confirming, rejecting, or closing a fact by hand leaves a record. |
| **Reasoning and derivation** | Expresses rules in temporal Datalog and runs them by forward chaining. Derived facts carry validity and provenance like extracted facts. A derivation path expands all the way back to the original sentence. Ontology axioms (type inheritance, relation hierarchy, transitivity, symmetry, inverses, disjointness, cardinality) compile into rules and take part in reasoning. |
| **Conflict detection** | Runs three checks, each with its own outcome. A temporal conflict resolves by closing the old fact, keeping both facts, or rejecting the new fact. An axiom violation in the data (a self-loop, an asymmetry, a transitive cycle, a cardinality violation) resolves by retracting the fact, relaxing the axiom, or accepting both. Utopia checks the ontology itself first, since a violation found in a self-contradictory ontology is noise. |
| **Ontology-driven querying** | Register a Postgres connection once and mount it on a knowledge base. Chat can then query documents and the database together. An exploration pass reads the mounted schema against the concepts already in the base and proposes mappings. The agent proposes; a person confirms. The method behind this ([Ontology2SQL](https://github.com/deeplethe/ontology2sql)) leads on BIRD Mini-Dev for both SQLite and PostgreSQL ([submission](https://github.com/bird-bench/bird-bench.github.io/pull/218)). |
| **Multi-user and permissions** | Scopes permissions per knowledge base. Each base has its own members and roles. Everyone in the deployment can read an open base. Only invited users can read a restricted base. A deployment has one system administrator: the first account registered. Each base has owner, admin, editor, and viewer roles. |
| **Decision ledger** | Logs every confirmation, rejection, merge, revert, and graph rebuild. Each log entry records the operator, the time, and a snapshot of the object at that point. You can still query a log entry after the object is invalidated or rebuilt. |
| **[Decision intelligence (in development)](#roadmap)** | Records decisions, replays both the understanding and the path a decision took, and reasons over overlaid scenarios. |

## Quick start

Requirements: Docker, Bun 1.1+, Postgres with pgvector.

```bash
# 1. Start Postgres
docker compose up -d db

# 2. Install
bun install

# 3. Backend
cd server && bun run src/index.ts

# 4. Frontend
cd web && bun install && bun run dev
```

Or run the full stack with Docker:

```bash
docker compose --profile app up -d
```

Open http://localhost:1516 and register. The first account becomes the administrator automatically. Utopia also creates a public knowledge base that everyone can read. Before you extract business documents, set the model endpoints (chat and embedding) under system settings.

## Roadmap

- [ ] **Decision reasoning**: compute constraints and replay a decision after the fact
- [ ] **Execution gate**: check an agent's calls against ontology rules and symbolic logic
- [ ] **Lakehouse for mapping and querying**: mapping exploration and Ontology2SQL over Iceberg, Delta Lake, Databricks, Snowflake, and MaxCompute
- [ ] **More sources**: MySQL, ClickHouse, and Doris drivers; S3, WebDAV, Notion, and Feishu connectors
- [ ] **Time to the moment**: add an `instant` precision beside year, month, and day, for sources that carry a real timestamp. Today a connector rounds a timestamp to a UTC day, which can shift an event to the wrong day
- [ ] **Agent memory over MCP**: episode writes, the retrieve endpoint, and the MCP server
- [ ] **Enterprise**: OIDC SSO, backup and restore commands, benchmarks at 100,000 documents

## Status

Utopia is at **v0.1**. The database schema changes between versions. Migrations only roll forward; there is no rollback. Pin a specific version with `UTOPIA_IMAGE` in production. Back up the database and the `data` directory before you upgrade.

Read [SECURITY.md](SECURITY.md) before you expose Utopia to the public internet.

## Star History

<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/deeplethe/utopia/assets/assets/star-history.svg">
  <img src="https://raw.githubusercontent.com/deeplethe/utopia/assets/assets/star-history-light.svg" alt="Star History" width="820">
</picture>

</div>

## Community

- 💬 [Discussions](https://github.com/deeplethe/utopia/discussions): ask questions, share experience, and give feedback
- 🐛 [Issues](https://github.com/deeplethe/utopia/issues): report a bug, ask a design question, or request a feature
- 🤝 [Contributing](CONTRIBUTING.md): dev setup, checks to run before you push, and DCO sign-off
- 🔌 [Ontology2SQL](https://github.com/deeplethe/ontology2sql): the ontology-driven text-to-SQL method referenced above

## License

[Apache-2.0](LICENSE)

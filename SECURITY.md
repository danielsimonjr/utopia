# Security

*[中文版](SECURITY.zh-CN.md)*

Utopia is at v0.1. This page lists **known, unresolved** limits. It is not a vulnerability report. It lists the places the design has not reached yet.

## Before you put this on a public network

**Utopia stores credentials in the clear.** LLM API keys and Ask-the-Data connection strings are plain text in Postgres (`llm_settings.chat_api_key`, `data_sources.conn_string`). Anyone who can read the database can read them. Encryption at rest is a 1.0 item. Until then, keep the system and its database inside a trusted network.

**The default database password is `utopia`.** By default, the port binds to loopback (`127.0.0.1:1517`), so nothing outside the host can connect. If you change `UTOPIA_DB_BIND` to expose it, change `UTOPIA_DB_PASSWORD` in `.env` first.

**A data source is only as safe as its grants.** Registering a data source is a deployment-level action, but its connection string reaches every workspace the source is granted to. Grant a source only where that database should be visible. Use a read-only database role in the connection string itself. The SQL gate described below is defense in depth. It is not a substitute for least privilege at the source.

## What is in place

- **A JWT signing key is generated on first start.** Utopia generates 32 bytes from a CSPRNG and stores them in the database. No deployment shares a default key.
- **The `Secure` flag on session cookies follows TLS.** Utopia reads `X-Forwarded-Proto` to decide this, so local HTTP development still works. Set `UTOPIA_COOKIE_SECURE=true` to force it if your proxy omits that header.
- **The database port binds to loopback**, at `127.0.0.1:1517`. The app reaches the database over the compose network.
- **An optional least-privilege runtime role.** Set `UTOPIA_APP_DB_PASSWORD` and `UTOPIA_MIGRATION_URL`, and the app connects as a role that can only read and write business tables and append to the ledger. Migrations still run as the owner.
- **A data source reaches only granted workspaces.** Utopia mounts a registered database into a knowledge base only where an explicit grant exists. Before this rule, any base admin could mount any registered source, which crossed tenant boundaries.
- **A read-only gate on Ask-the-Data.** Utopia enforces a parser allowlist, a read-only transaction, and a row limit. These three layers mean a statement that gets past the parser still cannot write.
- **Utopia deactivates accounts instead of deleting them.** `users.deactivated_at` blocks sign-in while the ledger keeps that person's decisions attributable.
- **Utopia hashes passwords with argon2.**

## Reporting a vulnerability

Open an issue. If it involves exploitable detail, start with the minimum needed to reproduce it. We will follow up privately.

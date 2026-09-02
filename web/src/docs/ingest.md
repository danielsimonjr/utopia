# Ingest interfaces

Utopia pulls or receives documents through **sources**. Two source kinds use JSON and support integration: **Custom** (Utopia polls your service) and **API** (your service pushes to Utopia). Both kinds share the same identity rule: every item has a stable ID. Pushing or returning the same ID again **updates the same document in place**. Utopia keeps the previous content as a version, re-indexes it for search, and re-extracts the knowledge graph.

## Choose between them

| | Custom (pull) | API (push) |
|---|---|---|
| Who starts the sync | Utopia, on a schedule | Your service, at any time |
| Auth | An optional header you configure | A per-source bearer token |
| Fits | Feeds, exports, periodic snapshots | Event-driven systems, scripts, CI |
| Deletion signal | `deleted` array in the response | `deleted: true` in a push |

---

## Custom source — the pull interface

1. Create a **Custom** source.
2. Point it at a URL you control.

On every sync (manual, interval, or cron), Utopia sends:

```
GET {endpoint}?since=2026-08-26T19:43:24Z
Authorization: <your configured header, if any>
```

- `since` is the time of the last successful sync (RFC 3339). Utopia **omits it on the first sync**. Return every item on that sync. After that, you may return only the items that changed since that time. Returning an unchanged item again is safe. Utopia skips it by content hash.
- If you configured an *Authorization header* on the source, Utopia sends it as-is in the `Authorization` header. Utopia stores this header on the server and never shows it again in any API response.

Respond with JSON:

```json
{
  "items": [
    {
      "id": "note-42",
      "title": "Deployment runbook",
      "content": "# Runbook\nRestart the ingest worker before each release.",
      "doc_time": "2026-08-20T09:00:00Z",
      "mime": "text/markdown"
    }
  ],
  "deleted": ["note-17"]
}
```

Field reference:

| Field | Required | Meaning |
|---|---|---|
| `id` | yes | The stable identity of the item within this source. The same `id` with new `content` updates the document in place. |
| `title` | no | The display name. Utopia infers the file extension from `mime` when `title` has none. Defaults to `id`. |
| `content` | yes | The full text of the item. Not a diff. |
| `doc_time` | no | RFC 3339. Sets the document's position on the time axis. Send the real publish or effective time when you have it. |
| `mime` | no | `text/markdown` (default), `text/plain`, or `text/html`. |
| `deleted` | no | An array of `id`s your source has retired. Utopia **marks the matching documents "Not in source"**. It does not delete them. A person confirms deletion in the Library. Returning an item again clears the mark. |

Notes:

- An item missing from a response is **not** treated as deleted, because the response can be incremental. Only the `deleted` array signals retirement.
- Utopia fetches endpoints on `localhost` directly. It bypasses any system HTTP proxy for these endpoints.

---

## API source — the push interface

1. Create an **API** source. Utopia gives it its own push token. View or rotate the token from the source's Token dialog.
2. Send a request:

```
POST {your-utopia-base}/api/v1/sources/{source_id}/ingest
Authorization: Bearer utp_…
Content-Type: application/json
```

```json
{
  "filename": "runbook.md",
  "content": "# Runbook\nRestart the ingest worker before each release.",
  "doc_time": "2026-08-20T09:00:00Z",
  "external_id": "note-42"
}
```

| Field | Required | Meaning |
|---|---|---|
| `filename` | yes | The display name. Also the fallback identity when `external_id` is absent. |
| `content` | yes* | The full text. *Optional when `deleted` is `true`.* |
| `doc_time` | no | RFC 3339. Sets the document's position on the time axis. |
| `external_id` | no | The stable identity. The same identity with new content updates the document in place. Without `external_id`, `filename` is the identity. |
| `deleted` | no | `true` marks the identified document "Not in source" (a tombstone). A later normal push of the same identity restores it. |

The response states what happened:

```json
{ "action": "created" }
```

`created` · `updated` · `moved` (same content, new name) · `unchanged` · `marked_missing`.

Example with curl:

```bash
curl -X POST "https://utopia.example.com/api/v1/sources/01a0…/ingest" \
  -H "Authorization: Bearer utp_…" \
  -H "Content-Type: application/json" \
  -d '{"filename":"runbook.md","content":"# Runbook v2 …","external_id":"note-42"}'
```

---

## Shared rules

- **Utopia tracks identity, not filenames.** It tracks documents by `custom:{id}` or `api:{external_id}` keys. A rename becomes a move. A content change updates the same document.
- **Updates keep history.** Every content change records a new version. Earlier extracted knowledge keeps its evidence.
- **Deletion is a marker.** A tombstone sets a "Not in source" flag. The Library shows a cleanup action, and a person confirms the actual deletion.
- **`doc_time` sets the position on the time axis.** A document without `doc_time` falls back to its ingestion time. A real timestamp makes the temporal graph more accurate.

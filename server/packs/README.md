# Prebuilt ontology packs

Each source file is stored as-is, compressed with gzip. The server embeds each file into the application at build time.

**Why the files are embedded instead of downloaded at runtime:** The README states that the whole system can run on a fully offline network. Fetching a pack at runtime would break that claim. It would also make the build non-reproducible, because the upstream file can change at any time.

**Why the files are compressed:** The uncompressed files total 1.7 MB. Compressed, they total 316 KB. This is a public repository, so clone size is a real cost. Decompression takes a few lines of code.

| File | Source | License | Fetch date |
|---|---|---|---|
| `schema-org.ttl.gz` | https://schema.org/version/latest/schemaorg-current-https.ttl | CC BY-SA 3.0 | 2026-08-30 |
| `w3c-org.ttl.gz` | https://www.w3.org/ns/org.ttl | W3C Document License | 2026-08-30 |
| `prov-o.ttl.gz` | https://www.w3.org/ns/prov.ttl | W3C Document License | 2026-08-30 |
| `foaf.rdf.gz` | http://xmlns.com/foaf/spec/index.rdf | CC BY 1.0 | 2026-08-30 |
| `iof-core.rdf.gz` | https://spec.industrialontologies.org/ontology/core/Core/ | MIT | 2026-08-30 |

## Update a pack

1. Fetch the new file from its source.
2. Compress it with `gzip -9c` and overwrite the old file.
3. Update the byte count where the pack size is recorded in the server code.
4. Update the fetch date in this file.

**Do not change the content of the source file.** Utopia's ontology projection covers only the part of a pack it can use today. The rest of the file stays intact for later use. This rule follows criterion 1 in [ADR 0001](../../../docs/decisions/0001-ontology-import-and-governance.md).

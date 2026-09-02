/**
 * utopia-ingest: the parser matrix plus chunking.
 *
 * Principle: handle text-layer formats natively (fast, no extra service);
 * scanned or complex-layout documents are out of scope here.
 */

import { chunkText, type ChunkPiece } from "./chunker";
import { csvText, docx, html, pdf, plainText, pptx, spreadsheet } from "./parsers";
import { sniff } from "./magic";

export { chunkText, type ChunkPiece };
export * as ontologyRdf from "./ontology_rdf";

/** A parse result: plain text plus (later) optional structure. */
export type ParsedDoc = {
  text: string;
};

/** Supported formats: pdf / docx / xlsx·xls·ods / pptx / md / txt / html / csv / json / yaml / xml / log. */
export async function parse(filename: string, bytes: Uint8Array): Promise<ParsedDoc> {
  const ext = (filename.split(".").pop() ?? "").toLowerCase();
  // Magic-number sniffing runs first — an extension can lie.
  const kind = sniff(bytes);

  let text: string;
  if (kind === "pdf" || ext === "pdf") {
    text = await pdf(bytes);
  } else if (kind === "docx" || ext === "docx") {
    text = await docx(bytes);
  } else if (kind === "xlsx" || kind === "ods" || kind === "xls" || ext === "xlsx" || ext === "xls" || ext === "ods") {
    text = spreadsheet(bytes);
  } else if (kind === "pptx" || ext === "pptx") {
    text = await pptx(bytes);
  } else if (ext === "html" || ext === "htm") {
    text = html(bytes);
  } else if (ext === "csv" || ext === "tsv") {
    text = csvText(bytes, ext === "tsv");
  } else {
    // md / json / yaml / xml / log / txt, and anything unrecognized: decode as text
    // (with a Latin-1 fallback for non-UTF-8 encodings).
    text = plainText(bytes);
  }

  const normalized = normalize(text);
  if (normalized.trim() === "") {
    throw new Error("No text could be extracted (possibly a scanned or empty file)");
  }
  return { text: normalized };
}

/** Collapses runs of blank lines and normalizes line endings. */
export function normalize(text: string): string {
  const unified = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  // Mirrors Rust's `str::lines()`: a trailing newline ends the last line,
  // it does not start a new (empty) one.
  const lines = unified.split("\n");
  if (unified.endsWith("\n")) lines.pop();
  let out = "";
  let blankRun = 0;
  for (const line of lines) {
    const trimmed = line.replace(/\s+$/, "");
    if (trimmed === "") {
      blankRun++;
      if (blankRun <= 1) out += "\n";
    } else {
      blankRun = 0;
      out += trimmed;
      out += "\n";
    }
  }
  return out;
}

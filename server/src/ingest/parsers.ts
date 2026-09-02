/**
 * Format parsers. Every parser outputs plain text (structure is kept as
 * markdown-style headings where that makes sense).
 */

import * as cheerio from "cheerio";
import JSZip from "jszip";
import * as XLSX from "xlsx";

/** Decodes bytes to text: UTF-8 first, and Latin-1 (which never fails) as the fallback. */
export function plainText(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("latin1").decode(bytes);
  }
}

export async function pdf(bytes: Uint8Array): Promise<string> {
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  let doc;
  try {
    doc = await getDocument({
      data: bytes,
      isEvalSupported: false,
      disableFontFace: true,
      useSystemFonts: true,
    }).promise;
  } catch (e) {
    throw new Error(`PDF text-layer extraction failed: ${(e as Error).message}`);
  }
  const pages: string[] = [];
  try {
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      const line = content.items
        .map((item) => ("str" in item ? (item as { str: string }).str : ""))
        .join("");
      pages.push(line);
    }
  } finally {
    await doc.destroy();
  }
  return pages.join("\n");
}

/** docx: unzips `word/document.xml`, takes `w:t` text, breaks a line at each `w:p`. */
export async function docx(bytes: Uint8Array): Promise<string> {
  const xml = await readZipEntry(bytes, "word/document.xml", "Malformed docx structure");
  return extractXmlText(xml, "w:t", "w:p");
}

/** pptx: parses `ppt/slides/slideN.xml` in page order, taking `a:t` text. */
export async function pptx(bytes: Uint8Array): Promise<string> {
  const zip = await JSZip.loadAsync(bytes).catch(() => {
    throw new Error("Failed to unzip pptx");
  });
  const slides: [number, string][] = [];
  zip.forEach((relPath) => {
    const m = /^ppt\/slides\/slide(\d+)\.xml$/.exec(relPath);
    if (m) slides.push([Number(m[1]), relPath]);
  });
  slides.sort((a, b) => a[0] - b[0]);

  let out = "";
  for (const [num, name] of slides) {
    const xml = await zip.file(name)!.async("string");
    const text = extractXmlText(xml, "a:t", "a:p");
    if (text.trim() !== "") {
      out += `\n## Slide ${num}\n${text}\n`;
    }
  }
  return out;
}

/** xlsx / xls / ods: reads every sheet, one tab-separated line per row (first 2000 rows of each sheet). */
export function spreadsheet(bytes: Uint8Array): string {
  let workbook: XLSX.WorkBook;
  try {
    workbook = XLSX.read(bytes, { type: "array" });
  } catch (e) {
    throw new Error(`Failed to open spreadsheet: ${(e as Error).message}`);
  }
  let out = "";
  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) continue;
    const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: "", blankrows: true });
    if (rows.length === 0) continue;
    out += `\n# Sheet: ${sheetName}\n`;
    for (const row of rows.slice(0, 2000)) {
      const line = row.map((c) => (c === "" || c === null || c === undefined ? "" : String(c)));
      if (line.some((s) => s !== "")) {
        out += line.join("\t");
        out += "\n";
      }
    }
  }
  return out;
}

/**
 * HTML: takes the body text.
 *
 * A real page's chrome is often bigger than its content — site-wide nav,
 * a language picker, a legal footer, editing tools. Walking the whole
 * document would feed all of that to the extractor: it wastes an LLM call
 * per chunk, and it turns things like "Main page" or "Privacy policy"
 * into entities that pollute the graph (one 647KB wiki article produced
 * 60 chunks this way, with the first chunk entirely sidebar menu and the
 * last entirely a copyright notice).
 *
 * So we look for a content container first (`main`, `[role=main]`,
 * `article`) and only fall back to the whole page when none is found. A
 * container can still nest navigation and form chrome, which the
 * skip-list in {@link walkHtml} handles.
 */
export function html(bytes: Uint8Array): string {
  const raw = plainText(bytes);
  const $ = cheerio.load(raw);
  let out = "";
  const title = $("title").first().text().trim();
  if (title !== "") out += `# ${title}\n\n`;

  let root: CheerioNode = $("main, [role=main], article").first();
  if (root.length === 0) root = $("body").first();
  if (root.length === 0) root = $.root();
  out += walkHtml(root, $);
  return out;
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type CheerioNode = any;

const SKIP_TAGS = new Set([
  "script",
  "style",
  "noscript",
  "head",
  "svg",
  "template",
  "nav",
  "header",
  "footer",
  "aside",
  "form",
  "button",
  "select",
  "iframe",
  "dialog",
]);
const BLOCK_TAGS = new Set(["p", "div", "li", "tr", "h1", "h2", "h3", "h4", "h5", "h6", "br", "section", "article"]);

function walkHtml(el: CheerioNode, $: cheerio.CheerioAPI): string {
  let out = "";
  el.contents().each((_: number, node: CheerioNode) => {
    if (node.type === "tag") {
      const tag = String(node.name).toLowerCase();
      // Nav/header/footer/sidebar/form controls are chrome even inside a
      // content container, so skip them unconditionally.
      if (SKIP_TAGS.has(tag)) return;
      out += walkHtml($(node), $);
      if (BLOCK_TAGS.has(tag) && !out.endsWith("\n")) out += "\n";
    } else if (node.type === "text") {
      const text: string = node.data ?? "";
      if (text.trim() !== "") out += text;
    }
  });
  return out;
}

export function csvText(bytes: Uint8Array, tsv: boolean): string {
  const decoded = plainText(bytes);
  const rows = parseDelimited(decoded, tsv ? "\t" : ",", 10_000);
  let out = "";
  for (const record of rows) {
    out += record.join(" | ");
    out += "\n";
  }
  return out;
}

// ---- helpers ----

async function readZipEntry(bytes: Uint8Array, name: string, failMessage: string): Promise<string> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes);
  } catch {
    throw new Error(failMessage);
  }
  const entry = zip.file(name);
  if (!entry) throw new Error(failMessage);
  return entry.async("string");
}

/**
 * Takes the text inside `textTag` (like `w:t`) out of an OOXML document,
 * breaking a line at every `paraTag` (like `w:p`).
 *
 * Only matched open/close pairs count, the same as the original
 * `quick-xml` event reader this replaces: a self-closing `<w:t/>` or
 * `<w:p/>` produces neither text nor a line break.
 */
function extractXmlText(xml: string, textTag: string, paraTag: string): string {
  let out = "";
  let inText = false;
  const tagRe = /<(\/?)([\w.:-]+)((?:\s[^>]*)?)(\/?)>/g;
  let lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(xml))) {
    if (inText) out += decodeXmlEntities(xml.slice(lastIndex, m.index));
    const closing = m[1] === "/";
    const selfClosing = m[4] === "/";
    const name = m[2]!;
    if (name === textTag) {
      if (!closing && !selfClosing) inText = true;
      else if (closing) inText = false;
    } else if (name === paraTag && closing) {
      out += "\n";
    }
    lastIndex = tagRe.lastIndex;
  }
  return out;
}

const XML_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function decodeXmlEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith("#x") || body.startsWith("#X")) {
      const code = Number.parseInt(body.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    if (body.startsWith("#")) {
      const code = Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return XML_ENTITIES[body] ?? whole;
  });
}

/** A small delimited-text reader: quoted fields, doubled-quote escaping, a row cap. */
function parseDelimited(text: string, delimiter: string, maxRows: number): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let sawAny = false;

  const pushField = () => {
    row.push(field);
    field = "";
  };
  const pushRow = () => {
    pushField();
    rows.push(row);
    row = [];
    sawAny = false;
  };

  for (let i = 0; i < text.length && rows.length < maxRows; i++) {
    const c = text[i];
    sawAny = true;
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"' && field === "") {
      inQuotes = true;
    } else if (c === delimiter) {
      pushField();
    } else if (c === "\r") {
      // ignore; \n follows
    } else if (c === "\n") {
      pushRow();
    } else {
      field += c;
    }
  }
  if (rows.length < maxRows && (sawAny || field !== "" || row.length > 0)) {
    pushRow();
  }
  return rows;
}

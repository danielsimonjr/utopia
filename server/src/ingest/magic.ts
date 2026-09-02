/**
 * Magic-number sniffing for the file kinds this module cares about.
 *
 * A file's extension can lie (a `.doc` that is really an HTML export, a
 * renamed `.zip`), so we look at the bytes first and fall back to the
 * extension only when the bytes do not say enough — an OOXML container
 * (docx/pptx/xlsx) is a zip file with specific member names, so we peek
 * inside it instead of trusting the outer extension.
 */
export type MagicKind = "pdf" | "docx" | "pptx" | "xlsx" | "ods" | "xls" | "zip" | null;

const PDF_MAGIC = "%PDF-";
const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04];
const OLE_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

function startsWith(bytes: Uint8Array, magic: number[]): boolean {
  if (bytes.length < magic.length) return false;
  for (let i = 0; i < magic.length; i++) {
    if (bytes[i] !== magic[i]) return false;
  }
  return true;
}

export function sniff(bytes: Uint8Array): MagicKind {
  if (bytes.length >= 5) {
    const head = Buffer.from(bytes.slice(0, 5)).toString("latin1");
    if (head === PDF_MAGIC) return "pdf";
  }
  if (startsWith(bytes, OLE_MAGIC)) return "xls";
  if (startsWith(bytes, ZIP_MAGIC)) {
    return sniffZipMember(bytes);
  }
  return null;
}

/**
 * OOXML and ODF containers are zip files that carry a telltale member
 * name. Zip stores file names as plain text in the local file header (and
 * again in the central directory at the end), so a byte search for the
 * telltale name works without unzipping.
 */
function sniffZipMember(bytes: Uint8Array): MagicKind {
  // Zip entry names sit in the first ~64KB for well-formed office files
  // (the content-defining parts come first); the central directory at
  // the end also repeats every name, so scan the last 64KB too.
  const head = Buffer.from(bytes.slice(0, Math.min(bytes.length, 65536))).toString("latin1");
  const tail =
    bytes.length > 65536
      ? Buffer.from(bytes.slice(bytes.length - 65536)).toString("latin1")
      : "";
  const has = (needle: string) => head.includes(needle) || tail.includes(needle);
  if (has("word/document.xml")) return "docx";
  if (has("ppt/presentation.xml") || has("ppt/slides/")) return "pptx";
  if (has("xl/workbook.xml")) return "xlsx";
  if (has("mimetype") && (head.includes("opendocument.spreadsheet") || tail.includes("opendocument.spreadsheet"))) {
    return "ods";
  }
  return "zip";
}

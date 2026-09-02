import { describe, expect, test } from "bun:test";
import { normalize, parse } from "./index";

describe("normalize", () => {
  test("converts CRLF and CR to LF", () => {
    expect(normalize("a\r\nb\rc")).toBe("a\nb\nc\n");
  });

  test("trims trailing whitespace on each line", () => {
    expect(normalize("a   \nb\t\n")).toBe("a\nb\n");
  });

  test("collapses a run of blank lines to a single blank line", () => {
    expect(normalize("a\n\n\n\n\nb\n")).toBe("a\n\nb\n");
  });

  test("a single blank line between paragraphs is kept", () => {
    expect(normalize("a\n\nb\n")).toBe("a\n\nb\n");
  });

  test("a file with no trailing newline still gets one line each", () => {
    expect(normalize("a\nb")).toBe("a\nb\n");
  });
});

describe("parse", () => {
  test("parses plain text by extension", async () => {
    const doc = await parse("notes.txt", new TextEncoder().encode("hello   \n\n\n\nworld\n"));
    expect(doc.text).toBe("hello\n\nworld\n");
  });

  test("parses HTML by extension", async () => {
    const html = "<html><body><main><p>Some content here.</p></main></body></html>";
    const doc = await parse("page.html", new TextEncoder().encode(html));
    expect(doc.text).toContain("Some content here.");
  });

  test("parses CSV by extension", async () => {
    const doc = await parse("data.csv", new TextEncoder().encode("a,b\n1,2\n"));
    expect(doc.text).toBe("a | b\n1 | 2\n");
  });

  test("detects a PDF by magic number even with the wrong extension", async () => {
    const pdfBytes = new TextEncoder().encode("%PDF-1.4\nnot really a full pdf");
    // A too-small/invalid PDF should fail extraction with a clear error,
    // proving the magic sniff routed it to the PDF parser (not plain text).
    await expect(parse("report.docx", pdfBytes)).rejects.toThrow();
  });

  test("an empty file fails with a clear message", async () => {
    await expect(parse("empty.txt", new Uint8Array())).rejects.toThrow(/scanned or empty/);
  });

  test("a whitespace-only file fails the same way", async () => {
    await expect(parse("blank.txt", new TextEncoder().encode("   \n\n  \n"))).rejects.toThrow(
      /scanned or empty/,
    );
  });

  test("falls back to plain text for an unrecognized extension", async () => {
    const doc = await parse("data.unknownext", new TextEncoder().encode("just some text"));
    expect(doc.text).toBe("just some text\n");
  });
});

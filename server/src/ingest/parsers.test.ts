import { describe, expect, test } from "bun:test";
import JSZip from "jszip";
import * as XLSX from "xlsx";
import { csvText, docx, html, pdf, plainText, pptx, spreadsheet } from "./parsers";

describe("plainText", () => {
  test("decodes valid UTF-8", () => {
    expect(plainText(new TextEncoder().encode("héllo 世界"))).toBe("héllo 世界");
  });

  test("falls back to Latin-1 for bytes that are not valid UTF-8", () => {
    // 0xE9 alone is not valid UTF-8, but is "é" in Latin-1 (windows-1252-ish).
    const bytes = new Uint8Array([0x68, 0x69, 0xe9]);
    expect(plainText(bytes)).toBe("hi\u00e9");
  });
});

describe("docx", () => {
  async function buildDocx(paragraphs: string[]): Promise<Uint8Array> {
    const zip = new JSZip();
    const body = paragraphs
      .map((p) => `<w:p><w:r><w:t>${p}</w:t></w:r></w:p>`)
      .join("");
    zip.file(
      "word/document.xml",
      `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`,
    );
    return zip.generateAsync({ type: "uint8array" });
  }

  test("extracts w:t text, breaking a line at each w:p", async () => {
    const bytes = await buildDocx(["First paragraph.", "Second paragraph."]);
    const text = await docx(bytes);
    expect(text).toBe("First paragraph.\nSecond paragraph.\n");
  });

  test("fails clearly when word/document.xml is missing", async () => {
    const zip = new JSZip();
    zip.file("readme.txt", "not a docx");
    const bytes = await zip.generateAsync({ type: "uint8array" });
    await expect(docx(bytes)).rejects.toThrow(/Malformed docx structure/);
  });
});

describe("pptx", () => {
  test("orders slides numerically and skips a blank slide", async () => {
    const zip = new JSZip();
    const slide = (text: string) =>
      `<?xml version="1.0"?><p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:sld>`;
    zip.file("ppt/slides/slide1.xml", slide("First slide"));
    zip.file("ppt/slides/slide2.xml", "<p:sld/>");
    zip.file("ppt/slides/slide10.xml", slide("Tenth slide"));
    const bytes = await zip.generateAsync({ type: "uint8array" });
    const text = await pptx(bytes);
    expect(text).toContain("## Slide 1\nFirst slide");
    expect(text).toContain("## Slide 10\nTenth slide");
    expect(text).not.toContain("Slide 2\n");
    expect(text.indexOf("Slide 1")).toBeLessThan(text.indexOf("Slide 10"));
  });
});

describe("spreadsheet", () => {
  test("reads every sheet as tab-separated rows", () => {
    const wb = XLSX.utils.book_new();
    const sheet1 = XLSX.utils.aoa_to_sheet([
      ["name", "age"],
      ["Alice", 30],
      ["", ""],
    ]);
    XLSX.utils.book_append_sheet(wb, sheet1, "People");
    const bytes = XLSX.write(wb, { type: "array", bookType: "xlsx" }) as Uint8Array;
    const text = spreadsheet(bytes);
    expect(text).toContain("# Sheet: People");
    expect(text).toContain("name\tage");
    expect(text).toContain("Alice\t30");
    // A fully blank row is not emitted.
    expect(text.split("\n").filter((l) => l.trim() === "" && l !== "").length).toBe(0);
  });
});

describe("html", () => {
  test("prefers <main> over surrounding chrome", () => {
    const page = `
      <html><head><title>My Page</title></head>
      <body>
        <nav>Home | About</nav>
        <header>Site header</header>
        <main><p>The real content.</p></main>
        <footer>Copyright 2024</footer>
      </body></html>`;
    const text = html(new TextEncoder().encode(page));
    expect(text).toContain("# My Page");
    expect(text).toContain("The real content.");
    expect(text).not.toContain("Home | About");
    expect(text).not.toContain("Site header");
    expect(text).not.toContain("Copyright 2024");
  });

  test("falls back to the whole body when there is no main/article", () => {
    const page = `<html><body><p>Only paragraph.</p></body></html>`;
    const text = html(new TextEncoder().encode(page));
    expect(text).toContain("Only paragraph.");
  });
});

describe("csvText", () => {
  test("parses comma-separated rows, joining fields with a pipe", () => {
    const csv = "a,b,c\n1,2,3\n";
    expect(csvText(new TextEncoder().encode(csv), false)).toBe("a | b | c\n1 | 2 | 3\n");
  });

  test("parses tab-separated rows", () => {
    const tsv = "a\tb\n1\t2\n";
    expect(csvText(new TextEncoder().encode(tsv), true)).toBe("a | b\n1 | 2\n");
  });

  test("handles quoted fields with embedded commas and escaped quotes", () => {
    const csv = 'name,quote\n"Smith, John","He said ""hi"""\n';
    expect(csvText(new TextEncoder().encode(csv), false)).toBe(
      'name | quote\nSmith, John | He said "hi"\n',
    );
  });

  test("a file with no trailing newline still yields its last row", () => {
    const csv = "a,b\n1,2";
    expect(csvText(new TextEncoder().encode(csv), false)).toBe("a | b\n1 | 2\n");
  });
});

describe("pdf", () => {
  /** A minimal, hand-built single-page PDF with an uncompressed content stream saying "Hello World". */
  function helloWorldPdf(): Uint8Array {
    const objs = [
      "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
      "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
      "3 0 obj\n<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /MediaBox [0 0 200 200] /Contents 5 0 R >>\nendobj\n",
      "4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n",
    ];
    const stream = "BT /F1 24 Tf 10 100 Td (Hello World) Tj ET";
    objs.push(`5 0 obj\n<< /Length ${stream.length} >>\nstream\n${stream}\nendstream\nendobj\n`);
    let out = "%PDF-1.4\n";
    const offsets: number[] = [0];
    for (const o of objs) {
      offsets.push(out.length);
      out += o;
    }
    const xrefStart = out.length;
    out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
    for (let i = 1; i <= objs.length; i++) {
      out += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
    }
    out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;
    return new TextEncoder().encode(out);
  }

  test("extracts the text layer", async () => {
    const text = await pdf(helloWorldPdf());
    expect(text).toContain("Hello World");
  });
});

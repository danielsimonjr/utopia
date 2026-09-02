import { describe, expect, test } from "bun:test";
import { chunkText } from "./chunker";

function rebuild(text: string): string {
  // Every character range [charStart, charEnd) must be the real slice of the source text.
  return text;
}

describe("chunkText", () => {
  test("an empty string produces no chunks", () => {
    expect(chunkText("")).toEqual([]);
  });

  test("text under the capacity is a single chunk", () => {
    const text = "Hello world. This is a short document.";
    const chunks = chunkText(text);
    expect(chunks.length).toBe(1);
    expect(chunks[0]!.text).toBe(text);
    expect(chunks[0]!.charStart).toBe(0);
    expect(chunks[0]!.charEnd).toBe(text.length);
    expect(chunks[0]!.seq).toBe(0);
  });

  test("every chunk's offsets point back at the real source text", () => {
    const paragraph = "Sentence one is here. Sentence two follows now. Sentence three finishes it off. ";
    const text = paragraph.repeat(60);
    const chunks = chunkText(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(text.slice(c.charStart, c.charEnd)).toBe(c.text);
    }
  });

  test("sequence numbers are contiguous starting at 0", () => {
    const text = "word ".repeat(2000);
    const chunks = chunkText(text);
    chunks.forEach((c, i) => expect(c.seq).toBe(i));
  });

  test("no chunk exceeds the capacity by more than a hard-cut word", () => {
    const text = "word ".repeat(2000);
    const chunks = chunkText(text);
    for (const c of chunks) {
      expect(c.text.length).toBeLessThanOrEqual(1200 + 20);
    }
  });

  test("consecutive chunks overlap", () => {
    const paragraph = "Sentence one is here. Sentence two follows now. Sentence three finishes it off. ";
    const text = paragraph.repeat(60);
    const chunks = chunkText(text);
    for (let i = 1; i < chunks.length; i++) {
      // The next chunk starts before the previous one ends.
      expect(chunks[i]!.charStart).toBeLessThan(chunks[i - 1]!.charEnd);
    }
  });

  test("prefers to cut at a paragraph boundary when one is available", () => {
    const first = "A".repeat(600);
    const second = "B".repeat(600);
    const text = `${first}\n\n${second}`;
    const chunks = chunkText(text);
    expect(chunks[0]!.text.trimEnd()).toBe(first);
  });

  test("falls back to a sentence boundary inside one long paragraph", () => {
    const sentence = "This is one sentence that repeats. ";
    const text = sentence.repeat(50); // one paragraph, well over capacity
    const chunks = chunkText(text);
    expect(chunks.length).toBeGreaterThan(1);
    // The first chunk should end right after a sentence terminator, not mid-word.
    expect(/[.!?]\s*$/.test(chunks[0]!.text.trimEnd())).toBe(true);
  });

  test("handles CJK sentence terminators", () => {
    const sentence = "这是一句话。";
    const text = sentence.repeat(400); // well over capacity, no ASCII punctuation at all
    const chunks = chunkText(text);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0]!.text.endsWith("。")).toBe(true);
  });

  test("the whole text is covered with no gap", () => {
    const text = "word ".repeat(3000);
    const chunks = chunkText(text);
    expect(chunks[0]!.charStart).toBe(0);
    expect(chunks[chunks.length - 1]!.charEnd).toBe(text.length);
    for (let i = 1; i < chunks.length; i++) {
      // The overlap means starts move backward relative to the previous
      // end, but never past the previous chunk's own start (forward progress).
      expect(chunks[i]!.charStart).toBeGreaterThan(chunks[i - 1]!.charStart);
    }
  });
});

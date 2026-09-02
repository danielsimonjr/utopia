import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DocsIndex, SearchIndex, rrfFuse } from "./index";

const dirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "utopia-search-"));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (dirs.length > 0) {
    const dir = dirs.pop()!;
    await rm(dir, { recursive: true, force: true });
  }
});

describe("SearchIndex", () => {
  test("search is limited to one knowledge base", async () => {
    const idx = await SearchIndex.open(await tempDir());
    await idx.reindexDocument("kb-1", "doc-1", [["c1", "the quick brown fox"]]);
    await idx.reindexDocument("kb-2", "doc-2", [["c2", "the quick brown fox"]]);

    const hitsKb1 = idx.search("kb-1", "fox", 10);
    expect(hitsKb1.map((h) => h.chunkId)).toEqual(["c1"]);

    const hitsKb2 = idx.search("kb-2", "fox", 10);
    expect(hitsKb2.map((h) => h.chunkId)).toEqual(["c2"]);
  });

  test("reindexing a document replaces its old chunks (delete then add)", async () => {
    const idx = await SearchIndex.open(await tempDir());
    await idx.reindexDocument("kb-1", "doc-1", [
      ["c1", "alpha"],
      ["c2", "beta"],
    ]);
    expect(idx.len()).toBe(2);

    await idx.reindexDocument("kb-1", "doc-1", [["c3", "gamma"]]);
    expect(idx.len()).toBe(1);
    expect(idx.search("kb-1", "alpha", 10)).toEqual([]);
    expect(idx.search("kb-1", "gamma", 10).map((h) => h.chunkId)).toEqual(["c3"]);
  });

  test("deleteDocument removes every chunk of that document", async () => {
    const idx = await SearchIndex.open(await tempDir());
    await idx.reindexDocument("kb-1", "doc-1", [
      ["c1", "alpha"],
      ["c2", "alpha beta"],
    ]);
    await idx.reindexDocument("kb-1", "doc-2", [["c3", "alpha gamma"]]);
    expect(idx.len()).toBe(3);

    await idx.deleteDocument("doc-1");
    expect(idx.len()).toBe(1);
    expect(idx.search("kb-1", "alpha", 10).map((h) => h.chunkId)).toEqual(["c3"]);
  });

  test("isEmpty and len track the document count", async () => {
    const idx = await SearchIndex.open(await tempDir());
    expect(idx.isEmpty()).toBe(true);
    await idx.reindexDocument("kb-1", "doc-1", [["c1", "text"]]);
    expect(idx.isEmpty()).toBe(false);
    expect(idx.len()).toBe(1);
  });

  test("a commit persists to disk and a fresh open reloads it", async () => {
    const dir = await tempDir();
    const idx = await SearchIndex.open(dir);
    await idx.reindexDocument("kb-1", "doc-1", [["c1", "persisted chunk"]]);

    const reopened = await SearchIndex.open(dir);
    expect(reopened.len()).toBe(1);
    expect(reopened.search("kb-1", "persisted", 10).map((h) => h.chunkId)).toEqual(["c1"]);
  });

  test("a deletion made after reopening still works (the doc map survives a reload)", async () => {
    const dir = await tempDir();
    const idx = await SearchIndex.open(dir);
    await idx.reindexDocument("kb-1", "doc-1", [["c1", "alpha"]]);

    const reopened = await SearchIndex.open(dir);
    await reopened.deleteDocument("doc-1");
    expect(reopened.isEmpty()).toBe(true);
  });

  /**
   * CJK text has no spaces between words. A whole sentence must not be
   * treated as one opaque token, or a query for one word inside it would
   * never match.
   */
  test("CJK text is searchable by a substring shorter than the whole sentence", async () => {
    const idx = await SearchIndex.open(await tempDir());
    await idx.reindexDocument("kb-1", "doc-1", [["c1", "北京大学是一所大学"]]);
    expect(idx.search("kb-1", "北京", 10).map((h) => h.chunkId)).toEqual(["c1"]);
    expect(idx.search("kb-1", "大学", 10).map((h) => h.chunkId)).toEqual(["c1"]);
  });

  test("a query with no alphanumeric or CJK content returns no hits, not an error", async () => {
    const idx = await SearchIndex.open(await tempDir());
    await idx.reindexDocument("kb-1", "doc-1", [["c1", "hello"]]);
    expect(idx.search("kb-1", "   ***   ", 10)).toEqual([]);
  });
});

describe("rrfFuse", () => {
  test("an id ranked first in every list wins", () => {
    const fused = rrfFuse([["a", "b", "c"], ["a", "c", "b"]], 10);
    expect(fused[0]).toBe("a");
  });

  test("appearing in more lists outranks appearing in only one, even at a similar rank", () => {
    const fused = rrfFuse([["x"], ["a", "b"], ["a", "c"]], 10);
    // "a" is rank 0 in two lists; "x" is rank 0 in one list only.
    expect(fused.indexOf("a")).toBeLessThan(fused.indexOf("x"));
  });

  test("the result is capped at limit", () => {
    const fused = rrfFuse([["a", "b", "c", "d"]], 2);
    expect(fused.length).toBe(2);
    expect(fused).toEqual(["a", "b"]);
  });

  test("an empty input produces an empty result", () => {
    expect(rrfFuse([], 10)).toEqual([]);
    expect(rrfFuse([[]], 10)).toEqual([]);
  });
});

describe("DocsIndex", () => {
  test("search finds a section by a word in its body", () => {
    const idx = DocsIndex.build([
      { slug: "intro", title: "Introduction", heading: "Getting started", anchor: "getting-started", body: "This guide covers installation and setup." },
      { slug: "intro", title: "Introduction", heading: "Advanced usage", anchor: "advanced-usage", body: "This section covers plugins." },
    ]);
    const hits = idx.search("installation", 10);
    expect(hits.length).toBe(1);
    expect(hits[0]!.anchor).toBe("getting-started");
  });

  test("search is CJK-aware", () => {
    const idx = DocsIndex.build([
      { slug: "s", title: "T", heading: "安装指南", anchor: "a", body: "本节介绍如何安装本体包。" },
    ]);
    expect(idx.search("安装", 10).length).toBe(1);
  });
});

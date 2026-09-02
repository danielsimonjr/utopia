/**
 * A CJK-aware tokenizer, shared by indexing and search.
 *
 * A plain whitespace tokenizer cannot see word boundaries in Chinese,
 * Japanese, or Korean text — there are no spaces between words. We split
 * a run of CJK characters into overlapping bigrams instead (`"北京大学"` →
 * `["北京", "京大", "大学"]`), which is the standard fallback when no
 * dictionary-based segmenter is available. A run of Latin letters or
 * digits is treated as one ordinary word.
 *
 * The same function must run at index time and at query time, or a query
 * for `"北京"` would not match a bigram index built with a different
 * split.
 */
export function tokenizeCjkAware(text: string): string[] {
  const terms: string[] = [];
  const runs = text.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+|[A-Za-z0-9]+/gu);
  if (!runs) return terms;
  for (const run of runs) {
    if (isCjkRun(run)) {
      if (run.length === 1) {
        terms.push(run);
      } else {
        for (let i = 0; i < run.length - 1; i++) {
          terms.push(run.slice(i, i + 2));
        }
      }
    } else {
      terms.push(run.toLowerCase());
    }
  }
  return terms;
}

function isCjkRun(run: string): boolean {
  const c = run.codePointAt(0) ?? 0;
  return (
    (c >= 0x4e00 && c <= 0x9fff) || // CJK Unified Ideographs
    (c >= 0x3040 && c <= 0x30ff) || // Hiragana + Katakana
    (c >= 0xac00 && c <= 0xd7a3) // Hangul syllables
  );
}

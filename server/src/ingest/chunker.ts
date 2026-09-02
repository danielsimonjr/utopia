/**
 * Chunking: semantic splitting (paragraph and sentence boundaries first),
 * with a character budget and an overlap.
 */

export type ChunkPiece = {
  seq: number;
  text: string;
  charStart: number;
  charEnd: number;
};

/** The default budget: 1200 characters (roughly 1000+ tokens for Chinese text), with a 150-character overlap. */
const CAPACITY = 1200;
const OVERLAP = 150;

/**
 * Splits text into overlapping pieces, at up to `CAPACITY` characters each.
 *
 * The cut point inside a window prefers, in order: a paragraph break, a
 * sentence break, a word break, and only as a last resort a hard cut in
 * the middle of a word. This keeps a chunk's boundary from landing in the
 * middle of a sentence whenever the text gives it a better place to cut.
 */
export function chunkText(text: string): ChunkPiece[] {
  const pieces: ChunkPiece[] = [];
  const n = text.length;
  if (n === 0) return pieces;

  let start = 0;
  let seq = 0;
  while (start < n) {
    const hardEnd = Math.min(start + CAPACITY, n);
    let end = hardEnd;
    if (hardEnd < n) {
      end = findBoundary(text, start, hardEnd) ?? hardEnd;
      if (end <= start) end = hardEnd;
    }
    pieces.push({ seq, text: text.slice(start, end), charStart: start, charEnd: end });
    seq++;
    if (end >= n) break;
    start = Math.max(start + 1, end - OVERLAP);
  }
  return pieces;
}

/** ASCII and CJK sentence terminators, optionally followed by a closing quote or bracket. */
const SENTENCE_END = /[.!?。！？](["'』」）)\]]?)(?=\s|$)/g;

/** Looks in `[start, hardEnd)` for the best place to end a chunk, preferring a wider boundary. */
function findBoundary(text: string, start: number, hardEnd: number): number | null {
  const window = text.slice(start, hardEnd);

  const paragraphAt = window.lastIndexOf("\n\n");
  if (paragraphAt > 0) return start + paragraphAt + 2;

  let sentenceEnd = -1;
  SENTENCE_END.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = SENTENCE_END.exec(window))) {
    sentenceEnd = m.index + m[0].length;
  }
  if (sentenceEnd > 0) return start + sentenceEnd;

  const lineAt = window.lastIndexOf("\n");
  if (lineAt > 0) return start + lineAt + 1;

  const spaceAt = window.lastIndexOf(" ");
  if (spaceAt > 0) return start + spaceAt + 1;

  return null;
}

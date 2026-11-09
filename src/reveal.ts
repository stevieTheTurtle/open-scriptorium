// Finds the exact word a PDF click refers to, near the source line SyncTeX reported.

export interface WordHit {
  line: number;
  character: number;
  length: number;
}

const WORD_SEPARATORS = /[^\p{L}\p{N}'’-]+/gu;

/** The first word of a raw selection, without punctuation. */
export function cleanWord(raw: string | undefined | null): string {
  return (raw ?? '').replace(WORD_SEPARATORS, ' ').trim().split(/\s+/)[0] ?? '';
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const SEARCH_OFFSETS = [0, -1, 1, -2, 2, -3, 3, -4, 4, -5, 5];
const CONTEXT_WINDOW = 90;

/**
 * @param line 0-based line SyncTeX reported
 * @param rawWord the word under the mouse in the PDF
 * @param context the PDF text line that was clicked, used to tell repeated words apart
 */
export function findWordNear(lines: string[], line: number, rawWord: string, context: string): WordHit | null {
  const word = cleanWord(rawWord).replace(/-$/, ''); // "believ-" (hyphenated) -> "believ"
  if (!word) return null;

  const pattern = new RegExp(`(^|[^\\p{L}\\p{N}])(${escapeRegExp(word)})`, 'gu');
  const contextWords = context
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 2);
  const target = Math.max(0, Math.min(line, lines.length - 1));

  for (const offset of SEARCH_OFFSETS) {
    const index = target + offset;
    if (index < 0 || index >= lines.length) continue;
    const text = lines[index];
    const found: number[] = [];
    pattern.lastIndex = 0;
    for (let m = pattern.exec(text); m; m = pattern.exec(text)) {
      found.push(m.index + m[1].length);
      if (m[0].length === 0) pattern.lastIndex++;
    }
    if (!found.length) continue;

    // Several occurrences on a long paragraph line: pick the one whose surroundings share most
    // words with the PDF line that was clicked.
    let best = found[0];
    let bestScore = -1;
    for (const position of found) {
      const around = text.slice(Math.max(0, position - CONTEXT_WINDOW), position + word.length + CONTEXT_WINDOW).toLowerCase();
      const score = contextWords.reduce((sum, w) => sum + (around.includes(w) ? 1 : 0), 0);
      if (score > bestScore) {
        bestScore = score;
        best = position;
      }
    }
    return { line: index, character: best, length: word.length };
  }
  return null;
}

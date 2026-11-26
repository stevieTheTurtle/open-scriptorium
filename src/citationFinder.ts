// Pure claim-cleaning, sentence extraction, LaTeX \cite insertion, .bib matching,
// and evidence-note JSON helpers. No vscode import, so everything here is directly unit-testable.

import type { BibFields } from './bib.ts';

export interface SupportCandidate {
  paper_id: string;
  citekey: string;
  title: string;
  authors: string[];
  year: number | null;
  tags: string[];
  file_path: string;
  page: number;
  quote: string;
  chunk: string;
  score: number;
  recall_rank: number;
}

export interface FindSupportResponse {
  claim: string;
  raw_claim: string;
  reranker: string;
  collection: string;
  elapsed_ms: number;
  results: SupportCandidate[];
}

export interface EvidenceNoteInput {
  quote: string;
  page?: number | string;
  file?: string;
  claim?: string;
  paper_id?: string;
  added?: string;
}

export interface CiteInsertionPlan {
  replaceStart: number;
  replaceEnd: number;
  insertText: string;
  alreadyPresent: boolean;
}

const LIGATURES: Record<string, string> = {
  '\ufb00': 'ff',
  '\ufb01': 'fi',
  '\ufb02': 'fl',
  '\ufb03': 'ffi',
  '\ufb04': 'ffl',
  '\u2018': "'",
  '\u2019': "'",
  '\u201c': '"',
  '\u201d': '"',
  '\u00a0': ' ',
};

const DROP_COMMANDS =
  /\\(?:cite[a-zA-Z]*|parencite|textcite|autocite|footcite|nocite|ref|eqref|cref|Cref|pageref|autoref|nameref|label|index|footnote|marginpar|gls[a-zA-Z]*|acr[a-zA-Z]*)\*?(?:\s*\[[^\]]*\]){0,2}\s*\{[^{}]*\}/g;

const UNWRAP_COMMANDS = new Set([
  'textbf',
  'textit',
  'emph',
  'underline',
  'texttt',
  'textsc',
  'textrm',
  'textsf',
  'text',
  'mathrm',
  'mathbf',
  'mathit',
  'enquote',
  'mbox',
  'hbox',
  'citeauthor',
  'title',
  'section',
  'subsection',
  'subsubsection',
  'paragraph',
  'caption',
  'hl',
  'textcolor',
]);

function unwrapBracedCommands(input: string): string {
  let out = input;
  for (let pass = 0; pass < 5; pass++) {
    let changed = false;
    let buf = '';
    let i = 0;
    const n = out.length;
    while (i < n) {
      if (out[i] === '\\') {
        const m = /^\\([A-Za-z]+)\*?/.exec(out.slice(i));
        if (m && UNWRAP_COMMANDS.has(m[1])) {
          let j = i + m[0].length;
          while (j < n && /\s/.test(out[j])) j++;
          while (j < n && out[j] === '[') {
            const closeOpt = out.indexOf(']', j + 1);
            if (closeOpt === -1) break;
            j = closeOpt + 1;
            while (j < n && /\s/.test(out[j])) j++;
          }
          if (m[1] === 'textcolor' && j < n && out[j] === '{') {
            let depth = 0;
            for (let k = j; k < n; k++) {
              if (out[k] === '{') depth++;
              else if (out[k] === '}' && --depth === 0) {
                j = k + 1;
                break;
              }
            }
            while (j < n && /\s/.test(out[j])) j++;
          }
          if (j < n && out[j] === '{') {
            let depth = 0;
            let matched = false;
            for (let k = j; k < n; k++) {
              if (out[k] === '{') depth++;
              else if (out[k] === '}' && --depth === 0) {
                buf += out.slice(j + 1, k);
                i = k + 1;
                changed = true;
                matched = true;
                break;
              }
            }
            if (matched) continue;
          }
        }
      }
      buf += out[i];
      i++;
    }
    out = buf;
    if (!changed) break;
  }
  return out;
}

/** Strips LaTeX macros, citations, comments and repairs PDF hyphens & ligatures. */
export function cleanClaimText(raw: string): string {
  if (!raw) return '';
  let s = raw.replace(/[\ufb00-\ufb04\u2018\u2019\u201c\u201d\u00a0]/g, (ch) => LIGATURES[ch] ?? ch);
  // Strip unescaped LaTeX line comments
  s = s.replace(/(?<!\\)%.*$/gm, '');
  // Repair PDF line-break hyphens (e.g. "inter-\naction" -> "interaction")
  s = s.replace(/([A-Za-z])-\s*\r?\n\s*([a-z])/g, '$1$2');
  // Strip citations, cross-refs, labels, footnotes
  for (let pass = 0; pass < 3; pass++) {
    const next = s.replace(DROP_COMMANDS, ' ');
    if (next === s) break;
    s = next;
  }
  s = unwrapBracedCommands(s);
  s = s
    .replaceAll('``', '"')
    .replaceAll("''", '"')
    .replaceAll('---', ' — ')
    .replaceAll('--', '–')
    .replaceAll('~', ' ')
    .replace(/\\([%&_$#{}])/g, '$1')
    .replace(/\\[,;:! ]/g, ' ')
    .replace(/\\\(|\\\)|\\\[|\\\]|\$\$|\$/g, ' ')
    .replace(/\\[A-Za-z]+\*?(?:\s*\[[^\]]*\])?/g, ' ')
    .replace(/[{}]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return s;
}

/** Extracts the sentence surrounding `character` on `lineText` when no text is selected. */
export function extractSentenceAtPosition(
  lineText: string,
  character: number,
): { text: string; start: number; end: number } {
  const withoutComment = lineText.replace(/(?<!\\)%.*$/, '');
  const len = withoutComment.length;
  const pos = Math.max(0, Math.min(character, len));

  let start = 0;
  for (let i = pos - 1; i >= 0; i--) {
    if (/[.!?]/.test(withoutComment[i]) && (i + 1 >= len || /\s/.test(withoutComment[i + 1]))) {
      start = i + 1;
      break;
    }
  }
  while (start < len && /\s/.test(withoutComment[start])) start++;

  let end = len;
  for (let i = pos; i < len; i++) {
    if (/[.!?]/.test(withoutComment[i]) && (i + 1 >= len || /\s/.test(withoutComment[i + 1]))) {
      end = i + 1;
      break;
    }
  }
  while (end > start && /\s/.test(withoutComment[end - 1])) end--;

  return { text: withoutComment.slice(start, end), start, end };
}

const CITE_AT_OFFSET_RE =
  /\\(?:cite[a-zA-Z]*|parencite|textcite|autocite|footcite)\*?(?:\s*\[[^\]]*\]){0,2}\s*\{([^}]*)\}/g;

/**
 * Computes where and what to insert for a LaTeX citation near `endOffset` on `lineText`.
 * - If an existing `\cite{...}` sits immediately at/before `endOffset`, appends `, key` inside it
 *   (unless `key` is already present).
 * - Otherwise inserts before trailing sentence punctuation (`.,;:!?`) with a leading `~` when
 *   immediately following a non-space token.
 */
export function computeCiteInsertion(
  lineText: string,
  endOffset: number,
  citeKey: string,
  citeCmd = '\\cite',
): CiteInsertionPlan {
  const cleanKey = citeKey.trim().replace(/^@/, '');
  const cmd = citeCmd.trim().startsWith('\\') ? citeCmd.trim() : `\\${citeCmd.trim() || 'cite'}`;
  let pos = Math.max(0, Math.min(endOffset, lineText.length));

  // Back up over trailing spaces
  while (pos > 0 && /[ \t]/.test(lineText[pos - 1])) pos--;

  // If the selection included trailing punctuation (e.g. "." or ","), place citation before it
  let beforePunct = pos;
  while (beforePunct > 0 && /[.,;:!?]/.test(lineText[beforePunct - 1]) && lineText[beforePunct - 2] !== '\\') {
    beforePunct--;
  }
  // Also skip spaces immediately preceding punctuation
  let checkPos = beforePunct;
  while (checkPos > 0 && /[ \t]/.test(lineText[checkPos - 1])) checkPos--;

  // Check if an existing \cite{...} ends right at checkPos (or contains pos)
  for (const m of lineText.matchAll(CITE_AT_OFFSET_RE)) {
    const start = m.index ?? 0;
    const end = start + m[0].length;
    const braceOpen = m[0].lastIndexOf('{') + start;
    const braceClose = end - 1;
    if ((checkPos >= braceOpen && checkPos <= end) || (pos >= start && pos <= end)) {
      const existingKeys = m[1]
        .split(',')
        .map((k) => k.trim())
        .filter(Boolean);
      if (existingKeys.includes(cleanKey)) {
        return { replaceStart: braceClose, replaceEnd: braceClose, insertText: '', alreadyPresent: true };
      }
      const sep = existingKeys.length ? ', ' : '';
      return { replaceStart: braceClose, replaceEnd: braceClose, insertText: `${sep}${cleanKey}`, alreadyPresent: false };
    }
  }

  const insertAt = beforePunct;
  const prevChar = insertAt > 0 ? lineText[insertAt - 1] : '';
  const needsTie = Boolean(prevChar && !/[\s(\[{`'"]/.test(prevChar));
  const prefix = needsTie ? '~' : '';
  return {
    replaceStart: insertAt,
    replaceEnd: insertAt,
    insertText: `${prefix}${cmd}{${cleanKey}}`,
    alreadyPresent: false,
  };
}

/** Appends a verbatim evidence note to a `references.notes.json` document without overwriting existing entries. */
export function appendEvidenceNoteJson(
  existingText: string | null,
  key: string,
  note: EvidenceNoteInput,
): { json: string; duplicate: boolean; count: number } {
  const cleanKey = key.trim().replace(/^@/, '');
  const cleanQuote = note.quote.trim();
  if (!cleanKey) throw new Error('Citation key must not be empty');
  if (!cleanQuote) throw new Error('Verbatim quote must not be empty');

  let data: Record<string, unknown> = {};
  if (existingText && existingText.trim()) {
    try {
      const parsed = JSON.parse(existingText.replace(/^\uFEFF/, ''));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        data = parsed as Record<string, unknown>;
      }
    } catch {
      // Keep empty object if file is corrupt so we don't crash; caller can warn if needed.
    }
  }

  const rawList = data[cleanKey];
  const existing: Array<Record<string, unknown>> = Array.isArray(rawList)
    ? rawList.filter((x): x is Record<string, unknown> => Boolean(x && typeof x === 'object'))
    : rawList && typeof rawList === 'object'
      ? [rawList as Record<string, unknown>]
      : [];

  const normFile = (note.file ?? '').trim().replaceAll('\\', '/');
  const entry: Record<string, unknown> = { quote: cleanQuote };
  if (note.page !== undefined && String(note.page).trim() !== '' && Number(note.page) !== 0) {
    const pStr = String(note.page).trim();
    entry.page = /^\d+$/.test(pStr) ? Number(pStr) : pStr;
  }
  if (normFile) entry.file = normFile;
  if (note.claim?.trim()) entry.claim = note.claim.trim();
  if (note.paper_id?.trim()) entry.paper_id = note.paper_id.trim();
  entry.added = (note.added?.trim() || new Date().toISOString().slice(0, 10));

  for (const prev of existing) {
    const prevQuote = typeof prev.quote === 'string' ? prev.quote.trim() : '';
    const prevFile = typeof prev.file === 'string' ? prev.file.trim().replaceAll('\\', '/') : '';
    if (prevQuote === cleanQuote && prevFile === normFile) {
      return {
        json: JSON.stringify(data, null, 2) + '\n',
        duplicate: true,
        count: existing.length,
      };
    }
  }

  existing.push(entry);
  data[cleanKey] = existing;
  return {
    json: JSON.stringify(data, null, 2) + '\n',
    duplicate: false,
    count: existing.length,
  };
}

function normTitle(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function surnameOf(author: string): string {
  const cleaned = author.trim();
  if (!cleaned) return '';
  const part = cleaned.includes(',') ? cleaned.split(',')[0] : cleaned.split(/\s+/).pop() ?? '';
  return normTitle(part);
}

/** Fallback matcher: finds a `.bib` key for a Zotero paper when it lacks an `@citekey` tag. */
export function matchBibKeyForPaper(
  paperTitle: string,
  authors: string[],
  bib: Map<string, BibFields>,
): string | null {
  const targetTitle = normTitle(paperTitle);
  if (!targetTitle || !bib.size) return null;
  const targetFirstAuthor = authors.length ? surnameOf(authors[0]) : '';

  let fuzzyMatch: string | null = null;
  for (const [key, fields] of bib) {
    const bibTitle = normTitle(fields.title ?? '');
    if (!bibTitle) continue;
    if (bibTitle === targetTitle) return key;

    if (
      !fuzzyMatch &&
      targetTitle.length >= 24 &&
      bibTitle.length >= 24 &&
      (bibTitle.includes(targetTitle) || targetTitle.includes(bibTitle))
    ) {
      if (!targetFirstAuthor) {
        fuzzyMatch = key;
      } else {
        const bibFirst = (fields.author ?? '').split(/\s+and\s+/)[0] ?? '';
        if (surnameOf(bibFirst) === targetFirstAuthor) fuzzyMatch = key;
      }
    }
  }
  return fuzzyMatch;
}

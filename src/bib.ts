// Minimal BibTeX reader: enough for completion details and citation popups.

export type BibFields = Record<string, string> & { type: string };

const ENTRY = /@([A-Za-z]+)\s*\{\s*([^,\s]+)\s*,/g;
const FIELD_NAME = /\s*([A-Za-z][\p{L}\p{N}_-]*)\s*=\s*/uy;
const COMMA = /\s*,/y;
const BARE_VALUE = /[^,}\s]+/y;

const ACCENTS: Record<string, string> = {
  "'": '́',
  '`': '̀',
  '^': '̂',
  '"': '̈',
  '~': '̃',
  c: '̧',
  v: '̌',
  '=': '̄',
  '.': '̇',
  u: '̆',
  H: '̋',
};

/** Light LaTeX to plain text: accents, braces and common text commands. */
export function detex(value: string): string {
  const accent = (_: string, mark: string, letter: string) => (letter + ACCENTS[mark]).normalize('NFC');
  return value
    .replace(/\\([`'^"~=.])\s*\{?\\?([A-Za-z])\}?/g, accent)
    .replace(/\\([cvuH])\s*\{\\?([A-Za-z])\}/g, accent)
    .replaceAll('\\&', '&')
    .replaceAll('\\%', '%')
    .replaceAll('\\_', '_')
    .replaceAll('--', '–')
    .replaceAll('~', ' ')
    .replace(/\\(?:textit|textbf|emph|textsc|texttt|mbox)\s*/g, '')
    .replace(/[{}]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function matchAt(pattern: RegExp, text: string, index: number): RegExpExecArray | null {
  pattern.lastIndex = index;
  return pattern.exec(text);
}

/** Reads a field value starting at `start`: {...}, "..." or bare. */
function readValue(text: string, start: number): { value: string; end: number } {
  let i = start;
  while (i < text.length && /\s/.test(text[i])) i++;
  if (i >= text.length) return { value: '', end: i };

  if (text[i] === '{') {
    let depth = 0;
    for (let j = i; j < text.length; j++) {
      if (text[j] === '{') depth++;
      else if (text[j] === '}' && --depth === 0) return { value: text.slice(i + 1, j), end: j + 1 };
    }
    return { value: text.slice(i + 1), end: text.length };
  }

  if (text[i] === '"') {
    let depth = 0;
    for (let j = i + 1; j < text.length; j++) {
      const c = text[j];
      if (c === '{') depth++;
      else if (c === '}') depth--;
      else if (c === '"' && depth === 0) return { value: text.slice(i + 1, j), end: j + 1 };
    }
    return { value: text.slice(i + 1), end: text.length };
  }

  const bare = matchAt(BARE_VALUE, text, i);
  return bare ? { value: bare[0], end: i + bare[0].length } : { value: '', end: i };
}

export function parseBib(text: string): Map<string, BibFields> {
  const entries = new Map<string, BibFields>();
  for (const match of text.matchAll(ENTRY)) {
    const type = match[1].toLowerCase();
    if (type === 'comment' || type === 'string' || type === 'preamble') continue;
    const fields = { type } as BibFields;
    let i = match.index + match[0].length;
    while (i < text.length) {
      const name = matchAt(FIELD_NAME, text, i);
      if (!name) break;
      const { value, end } = readValue(text, i + name[0].length);
      fields[name[1].toLowerCase()] = detex(value);
      i = end;
      const comma = matchAt(COMMA, text, i);
      if (!comma) break;
      i += comma[0].length;
    }
    entries.set(match[2], fields);
  }
  return entries;
}

export function shortAuthors(author: string | undefined): string {
  const names = (author ?? '')
    .split(/\s+and\s+/)
    .map((n) => n.trim())
    .filter(Boolean);
  const last = (name: string) => (name.includes(',') ? name.split(',')[0].trim() : name.split(/\s+/).pop()!);
  if (!names.length) return '';
  if (names.length === 1) return last(names[0]);
  if (names.length === 2) return `${last(names[0])} & ${last(names[1])}`;
  return `${last(names[0])} et al.`;
}

export function venueOf(fields: BibFields): string {
  return fields.journal || fields.booktitle || fields.school || fields.publisher || '';
}

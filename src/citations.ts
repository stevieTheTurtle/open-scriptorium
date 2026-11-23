// Pure citation data parsing and merging: .bib metadata + evidence notes + external status JSON.
// No editor dependencies, so it can be tested on its own.

import { shortAuthors, venueOf, type BibFields } from './bib.ts';

export interface CitationNote {
  quote: string;
  page?: number | string;
  file?: string;
  claim?: string;
}

export interface CitationPaperRef {
  title: string;
  page?: number | string;
  quote?: string;
  quotePage?: number | string;
}

export interface CitationProvenance {
  count: number;
  papers: CitationPaperRef[];
}

export interface CitationStatus {
  indexed: boolean | null;
  citedIn: CitationProvenance | null;
  inside: CitationPaperRef | null;
}

export interface CitationEntry {
  title: string;
  authors: string;
  shortAuthors: string;
  year: string;
  venue: string;
  indexed: boolean | null;
  notes: CitationNote[];
  citedIn: CitationProvenance | null;
  inside: CitationPaperRef | null;
}

function asPaperRef(raw: unknown): CitationPaperRef | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.title !== 'string' || !obj.title.trim()) return null;
  const ref: CitationPaperRef = { title: obj.title };
  if (typeof obj.page === 'number' || typeof obj.page === 'string') ref.page = obj.page;
  if (typeof obj.quote === 'string' && obj.quote.trim()) ref.quote = obj.quote;
  const quotePage = obj.quotePage ?? obj.quote_page;
  if (typeof quotePage === 'number' || typeof quotePage === 'string') ref.quotePage = quotePage;
  return ref;
}

function asProvenance(raw: unknown): CitationProvenance | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const count = typeof obj.count === 'number' && Number.isFinite(obj.count) ? obj.count : 0;
  const papers = Array.isArray(obj.papers) ? obj.papers.map(asPaperRef).filter((p): p is CitationPaperRef => p !== null) : [];
  return { count, papers };
}

/** Reads a notes JSON file ({ key: note | note[] }), ignoring keys that start with "_". */
export function parseNotesFile(text: string): Map<string, CitationNote[]> {
  const result = new Map<string, CitationNote[]>();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return result;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return result;

  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (key.startsWith('_')) continue;
    const list = Array.isArray(value) ? value : value && typeof value === 'object' ? [value] : [];
    const notes: CitationNote[] = [];
    for (const item of list) {
      if (!item || typeof item !== 'object') continue;
      const obj = item as Record<string, unknown>;
      if (typeof obj.quote !== 'string' || !obj.quote.trim()) continue;
      const note: CitationNote = { quote: obj.quote };
      if (typeof obj.page === 'number' || typeof obj.page === 'string') note.page = obj.page;
      if (typeof obj.file === 'string' && obj.file) note.file = obj.file;
      if (typeof obj.claim === 'string' && obj.claim) note.claim = obj.claim;
      notes.push(note);
    }
    if (notes.length) result.set(key, notes);
  }
  return result;
}

/** Reads a citation status JSON file ({ version: 1, citations: { key: { indexed, citedIn, inside } } }). */
export function parseStatusFile(text: string): Map<string, CitationStatus> {
  const result = new Map<string, CitationStatus>();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return result;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return result;
  const root = parsed as Record<string, unknown>;
  const map = root.citations && typeof root.citations === 'object' && !Array.isArray(root.citations) ? (root.citations as Record<string, unknown>) : root;

  for (const [key, value] of Object.entries(map)) {
    if (key.startsWith('_') || !value || typeof value !== 'object' || Array.isArray(value)) continue;
    const obj = value as Record<string, unknown>;
    const indexed = typeof obj.indexed === 'boolean' ? obj.indexed : null;
    const citedIn = asProvenance(obj.citedIn ?? obj.cited_in);
    const inside = asPaperRef(obj.inside);
    if (indexed === null && !citedIn && !inside) continue;
    result.set(key, { indexed, citedIn, inside });
  }
  return result;
}

/** Merges BibTeX entries, evidence notes, and external status into the payload sent to the PDF viewer. */
export function mergeCitations(
  bib: Map<string, BibFields>,
  notes: Map<string, CitationNote[]>,
  status: Map<string, CitationStatus>,
): Record<string, CitationEntry> {
  const keys = new Set<string>([...bib.keys(), ...notes.keys(), ...status.keys()]);
  const out: Record<string, CitationEntry> = {};
  for (const key of keys) {
    const fields = bib.get(key);
    const st = status.get(key);
    out[key] = {
      title: fields?.title ?? '',
      authors: fields?.author ?? '',
      shortAuthors: shortAuthors(fields?.author),
      year: fields?.year ?? '',
      venue: fields ? venueOf(fields) : '',
      indexed: st?.indexed ?? null,
      notes: notes.get(key) ?? [],
      citedIn: st?.citedIn ?? null,
      inside: st?.inside ?? null,
    };
  }
  return out;
}

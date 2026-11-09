// Minimal SyncTeX reader: the two lookups an editor needs, with no external `synctex` binary.
//   edit (PDF to source): page + point            -> file + line
//   view (source to PDF): file + line             -> page + boxes
// Coordinates are PDF big points (1/72 in) measured from the TOP-LEFT of the page, which is what
// a canvas-based viewer gets after dividing by its render scale.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { gunzipSync } from 'node:zlib';

const SP_PER_BP = 65781.76; // TeX scaled points per PDF big point

// Record lines of the Content section, e.g. "(12,345:4736286,5871186:26105518,665187,285084" (hbox),
// "[..." (vbox), "x12,345:7450437,5871186" (current point), "k12,345:22294665,5871186:10337232" (kern).
// Some engines add a column: "12,345,7:...".
const RECORD = /^([[(hvxkg$r])(\d+),(\d+)(?:,-?\d+)?:(-?\d+),(-?\d+)(?::(-?\d+)(?:,(-?\d+),(-?\d+))?)?/;

interface Leaf {
  tag: number;
  line: number;
  h: number;
  v: number;
}

class Box {
  readonly leaves: Leaf[] = [];
  readonly tag: number;
  readonly line: number;
  readonly h: number;
  readonly v: number;
  readonly w: number;
  readonly ht: number;
  readonly dp: number;

  constructor(tag: number, line: number, h: number, v: number, w: number, ht: number, dp: number) {
    this.tag = tag;
    this.line = line;
    this.h = h;
    this.v = v;
    this.w = w;
    this.ht = ht;
    this.dp = dp;
  }

  contains(x: number, y: number, slack: number): boolean {
    const left = Math.min(this.h, this.h + this.w);
    const right = Math.max(this.h, this.h + this.w);
    return left - slack <= x && x <= right + slack && this.v - this.ht - slack <= y && y <= this.v + this.dp + slack;
  }

  area(): number {
    return Math.abs(this.w) * Math.max(this.ht + this.dp, 0.1);
  }
}

interface PageData {
  hboxes: Box[];
  leaves: Leaf[];
}

export interface SourceLocation {
  /** Path relative to the project folder, with forward slashes. */
  file: string;
  line: number;
}

export interface PdfBox {
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ViewResult {
  line: number;
  boxes: PdfBox[];
}

function firstMin<T>(items: T[], key: (item: T) => number): T {
  let best = items[0];
  let bestKey = key(best);
  for (const item of items.slice(1)) {
    const k = key(item);
    if (k < bestKey) {
      best = item;
      bestKey = k;
    }
  }
  return best;
}

function firstMax<T>(items: T[], key: (item: T) => number): T {
  return firstMin(items, (item) => -key(item));
}

export class SyncTexData {
  readonly mtimeMs: number;
  /** tag -> project-relative path; only files inside the project are kept. */
  private readonly inputs = new Map<number, string>();
  private readonly pages = new Map<number, PageData>();
  private readonly sourceCache = new Map<string, string[] | null>();
  private readonly projectDir: string;

  constructor(text: string, projectDir: string, mtimeMs = 0) {
    this.projectDir = path.resolve(projectDir);
    this.mtimeMs = mtimeMs;
    this.parse(text);
  }

  private normalizeInput(raw: string): string | null {
    let p = raw.trim().replace(/\\/g, '/');
    if (!p) return null; // Tectonic leaves the name empty for files from its bundle
    p = path.resolve(this.projectDir, p);
    if (!path.extname(p) && fs.existsSync(`${p}.tex`)) p += '.tex';
    const relative = path.relative(this.projectDir, p);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null;
    return relative.split(path.sep).join('/');
  }

  private addInput(line: string): void {
    const first = line.indexOf(':');
    const second = line.indexOf(':', first + 1);
    if (second < 0) return;
    const relative = this.normalizeInput(line.slice(second + 1));
    if (relative) this.inputs.set(Number(line.slice(first + 1, second)), relative);
  }

  private parse(text: string): void {
    let unit = 1;
    let mag = 1000;
    let xOff = 0;
    let yOff = 0;
    let scale = 1;
    let inContent = false;
    let page: PageData | null = null;
    let stack: Box[] = [];

    for (const raw of text.split(/\r\n|\n|\r/)) {
      if (!inContent) {
        if (raw.startsWith('Input:')) this.addInput(raw);
        else if (raw.startsWith('Unit:')) unit = parseFloat(raw.slice(5));
        else if (raw.startsWith('Magnification:')) mag = parseFloat(raw.slice(14)) || 1000;
        else if (raw.startsWith('X Offset:')) xOff = parseFloat(raw.slice(9));
        else if (raw.startsWith('Y Offset:')) yOff = parseFloat(raw.slice(9));
        else if (raw.startsWith('Content:')) {
          inContent = true;
          scale = (unit * (mag / 1000)) / SP_PER_BP;
        }
        continue;
      }

      if (!raw) continue;
      const c = raw[0];
      if (c === '{') {
        page = { hboxes: [], leaves: [] };
        this.pages.set(parseInt(raw.slice(1), 10), page);
        stack = [];
        continue;
      }
      if (c === '}') {
        page = null;
        continue;
      }
      if (c === ')' || c === ']') {
        stack.pop();
        continue;
      }
      if (c === 'I' && raw.startsWith('Input:')) {
        this.addInput(raw); // inputs may also appear mid-content
        continue;
      }
      if (!page) continue;

      const m = RECORD.exec(raw);
      if (!m) continue;
      const tag = Number(m[2]);
      const line = Number(m[3]);
      const h = (Number(m[4]) + xOff) * scale;
      const v = (Number(m[5]) + yOff) * scale;
      const parent = stack.length ? stack[stack.length - 1] : null;
      if (m[1] === '[' || m[1] === '(') {
        const box = new Box(tag, line, h, v, Number(m[6] ?? 0) * scale, Number(m[7] ?? 0) * scale, Number(m[8] ?? 0) * scale);
        stack.push(box);
        if (m[1] === '(') page.hboxes.push(box);
      } else {
        const leaf: Leaf = { tag, line, h, v };
        page.leaves.push(leaf);
        parent?.leaves.push(leaf);
      }
    }
  }

  /** PDF to source: a click at (x, y) on a 1-based page. */
  edit(pageNumber: number, x: number, y: number): SourceLocation | null {
    const data = this.pages.get(pageNumber);
    if (!data) return null;
    const inProject = (tag: number) => this.inputs.has(tag);

    // 1) the smallest hbox under the cursor that belongs to a project file (or has project leaves)
    let best: { box: Box; leaves: Leaf[] } | null = null;
    for (const slack of [0, 2]) {
      const hits = data.hboxes
        .filter((b) => b.contains(x, y, slack) && Math.abs(b.w) > 0.5)
        .sort((a, b) => a.area() - b.area());
      for (const box of hits) {
        const leaves = box.leaves.filter((l) => inProject(l.tag));
        if (leaves.length || inProject(box.tag)) {
          best = { box, leaves };
          break;
        }
      }
      if (best) break;
    }

    if (best) {
      if (best.leaves.length) {
        // Leaves sit at the left edge of the material that follows them: take the last one at or
        // before the click, otherwise the first one after it.
        const before = best.leaves.filter((l) => l.h <= x + 0.5);
        const leaf = before.length ? firstMax(before, (l) => l.h) : firstMin(best.leaves, (l) => l.h);
        return this.result(leaf.tag, leaf.line);
      }
      return this.result(best.box.tag, best.box.line);
    }

    // 2) nothing under the cursor: the nearest project leaf on the page
    let candidates = data.leaves.filter((l) => inProject(l.tag));
    if (!candidates.length) {
      candidates = data.hboxes.filter((b) => inProject(b.tag)).map((b) => ({ tag: b.tag, line: b.line, h: b.h, v: b.v }));
    }
    if (!candidates.length) return null;
    const leaf = firstMin(candidates, (l) => (Math.abs(l.v - y) * 3) ** 2 + (l.h - x) ** 2);
    return this.result(leaf.tag, leaf.line);
  }

  private result(tag: number, line: number): SourceLocation | null {
    const file = this.inputs.get(tag);
    if (!file || line <= 0) return null;
    // TeX stamps the end of a paragraph with the blank line that closed it: snap back to text.
    const lines = this.sourceLines(file);
    if (lines) {
      let ln = Math.min(line, lines.length);
      while (ln > 1 && !lines[ln - 1].trim()) ln--;
      line = ln;
    }
    return { file, line };
  }

  private sourceLines(relative: string): string[] | null {
    if (!this.sourceCache.has(relative)) {
      try {
        this.sourceCache.set(relative, fs.readFileSync(path.join(this.projectDir, relative), 'utf8').split('\n'));
      } catch {
        this.sourceCache.set(relative, null);
      }
    }
    return this.sourceCache.get(relative) ?? null;
  }

  /**
   * Source to PDF: one box per typeset line produced by that source line, in reading order.
   * A long source line (a whole paragraph) yields several boxes; the viewer picks one.
   */
  view(relativeFile: string, line: number): ViewResult | null {
    let wanted = relativeFile.replace(/\\/g, '/');
    while (wanted.startsWith('./')) wanted = wanted.slice(2);
    const tags = new Set<number>();
    for (const [tag, file] of this.inputs) if (file === wanted) tags.add(tag);
    if (!tags.size) return null;

    const byLine = new Map<number, { page: number; box: Box }[]>();
    for (const [page, data] of this.pages) {
      for (const box of data.hboxes) {
        if (Math.abs(box.w) < 0.5) continue;
        const lines = new Set<number>();
        for (const leaf of box.leaves) if (tags.has(leaf.tag)) lines.add(leaf.line);
        if (tags.has(box.tag) && !box.leaves.length) lines.add(box.line);
        for (const ln of lines) {
          if (!byLine.has(ln)) byLine.set(ln, []);
          byLine.get(ln)!.push({ page, box });
        }
      }
    }
    if (!byLine.size) return null;

    // the exact line, else the nearest following line, else the nearest preceding one
    const target = firstMin([...byLine.keys()], (l) => Math.abs(l - line) + (l < line ? 0.5 : 0));
    const ordered = [...byLine.get(target)!].sort(
      (a, b) => a.page - b.page || a.box.v - b.box.v || Math.abs(b.box.w) - Math.abs(a.box.w),
    );

    const boxes: PdfBox[] = [];
    const seen = new Set<string>();
    for (const { page, box } of ordered) {
      const key = `${page}:${Math.round(box.v)}`;
      if (seen.has(key)) continue; // nested boxes on the same baseline: keep the widest
      seen.add(key);
      boxes.push({
        page,
        x: Math.min(box.h, box.h + box.w),
        y: box.v - box.ht,
        width: Math.abs(box.w),
        height: Math.max(box.ht + box.dp, 1),
      });
    }
    return { line: target, boxes };
  }
}

const cache = new Map<string, SyncTexData>();

/** Loads the SyncTeX data of a build, cached until the file changes. Null when there is none. */
export function loadSyncTex(synctexPath: string, projectDir: string): SyncTexData | null {
  let mtimeMs: number;
  try {
    mtimeMs = fs.statSync(synctexPath).mtimeMs;
  } catch {
    return null;
  }
  const key = `${synctexPath}\0${projectDir}`;
  const cached = cache.get(key);
  if (cached && cached.mtimeMs === mtimeMs) return cached;
  const bytes = fs.readFileSync(synctexPath);
  const text = (synctexPath.endsWith('.gz') ? gunzipSync(bytes) : bytes).toString('utf8');
  const data = new SyncTexData(text, projectDir, mtimeMs);
  cache.set(key, data);
  return data;
}

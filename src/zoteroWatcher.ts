import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Lightweight "new paper in Zotero" detector. Zotero stores every imported attachment in its own
 * `storage/<KEY>/` folder, so adding (or purging) a PDF changes the `storage/` directory's mtime.
 * Polling that single `stat` is effectively free, needs no SQLite access and no Zotero plugin.
 * Metadata-only edits (tags, titles) do not touch `storage/` and are left to the periodic sync.
 */
export interface ZoteroWatcherOptions {
  zoteroDir: string;
  /** Called once the storage folder has changed and then stayed quiet for `quietMs`. */
  onChange: () => Promise<unknown> | void;
  pollMs?: number;
  quietMs?: number;
  /** Injectable for tests: returns a change signature for the watched path, or undefined if missing. */
  signature?: (p: string) => Promise<string | undefined>;
  now?: () => number;
}

async function statSignature(p: string): Promise<string | undefined> {
  try {
    const s = await fs.promises.stat(p);
    return `${s.mtimeMs}`;
  } catch {
    return undefined;
  }
}

export class ZoteroWatcher {
  private timer: NodeJS.Timeout | undefined;
  private baseline: string | undefined;
  private lastSeen: string | undefined;
  private changedAt: number | undefined;
  private initialized = false;
  private busy = false;
  private readonly storageDir: string;
  private readonly pollMs: number;
  private readonly quietMs: number;
  private readonly signature: (p: string) => Promise<string | undefined>;
  private readonly now: () => number;
  private readonly opts: ZoteroWatcherOptions;

  constructor(opts: ZoteroWatcherOptions) {
    this.opts = opts;
    this.storageDir = path.join(opts.zoteroDir, 'storage');
    this.pollMs = opts.pollMs ?? 1000;
    this.quietMs = opts.quietMs ?? 3000;
    this.signature = opts.signature ?? statSignature;
    this.now = opts.now ?? Date.now;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.pollMs);
    this.timer.unref?.();
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** One poll step. Public so tests can drive it deterministically. */
  async tick(): Promise<void> {
    if (this.busy) return; // a previous tick (or the sync it triggered) is still running
    this.busy = true;
    try {
      const sig = await this.signature(this.storageDir);
      const now = this.now();
      if (!this.initialized) {
        this.initialized = true;
        this.baseline = this.lastSeen = sig;
        return;
      }
      if (sig !== this.lastSeen) {
        // Still changing (Zotero may be downloading/writing the PDF): restart the quiet window.
        this.lastSeen = sig;
        this.changedAt = now;
        return;
      }
      if (sig !== this.baseline && this.changedAt !== undefined && now - this.changedAt >= this.quietMs) {
        this.changedAt = undefined;
        this.baseline = sig; // changes arriving during the sync differ from this and re-trigger
        try {
          await this.opts.onChange();
        } catch {
          // Sync errors are reported by the caller; keep watching.
        }
      }
    } finally {
      this.busy = false;
    }
  }
}

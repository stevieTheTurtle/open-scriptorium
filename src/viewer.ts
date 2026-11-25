// The PDF tab: a read-only custom editor around the PDF.js webview.

import * as vscode from 'vscode';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { PdfBox } from './synctex.ts';
import type { CitationEntry } from './citations.ts';

export const VIEW_TYPE = 'openScriptorium.pdf';
const WATCH_DEBOUNCE_MS = 200;
const OPEN_TIMEOUT_MS = 5000;

export interface RevealRequest {
  boxes: PdfBox[];
  /** Cursor column and line length, used to estimate which typeset line a long paragraph maps to. */
  character: number;
  lineLength: number;
  word: string;
}

export interface InverseSearchRequest {
  page: number;
  x: number;
  y: number;
  word: string;
  context: string;
}

export interface ResolveCiteFileRequest {
  requestId: number;
  page: number;
  x: number;
  y: number;
}

export interface CompileStatus {
  state: 'idle' | 'compiling' | 'success' | 'error';
  durationMs?: number;
  errors?: number;
  warnings?: number;
  message?: string;
}

export interface ViewerInfo {
  /** How many times a PDF finished loading in this tab. */
  loads: number;
  numPages: number;
  page: number;
  zoom: number;
  lastRevealedPage: number | null;
  lastError: string | null;
}

interface Entry {
  uri: vscode.Uri;
  panel: vscode.WebviewPanel;
  loaded: boolean;
  /** Identifies the file contents last sent, so an unchanged PDF is not reloaded. */
  signature: string | null;
  pendingReveal: RevealRequest | null;
  lastCompileStatus: CompileStatus;
  autoCompileMode: string;
  debounce: NodeJS.Timeout | undefined;
  info: ViewerInfo;
}

export class PdfViewer implements vscode.CustomReadonlyEditorProvider {
  private readonly entries = new Map<string, Entry>();
  private readonly busy = new Set<string>();
  private readonly inverseSearch = new vscode.EventEmitter<{ uri: vscode.Uri; request: InverseSearchRequest }>();
  readonly onInverseSearch = this.inverseSearch.event;
  private readonly ready = new vscode.EventEmitter<vscode.Uri>();
  readonly onReady = this.ready.event;
  private readonly resolveCiteFile = new vscode.EventEmitter<{ uri: vscode.Uri; request: ResolveCiteFileRequest }>();
  readonly onResolveCiteFile = this.resolveCiteFile.event;
  private readonly toggleAutoCompile = new vscode.EventEmitter<vscode.Uri>();
  readonly onToggleAutoCompile = this.toggleAutoCompile.event;
  private readonly showLog = new vscode.EventEmitter<vscode.Uri>();
  readonly onShowLog = this.showLog.event;

  private readonly extensionUri: vscode.Uri;

  constructor(extensionUri: vscode.Uri) {
    this.extensionUri = extensionUri;
  }

  openCustomDocument(uri: vscode.Uri): vscode.CustomDocument {
    return { uri, dispose: () => undefined };
  }

  resolveCustomEditor(document: vscode.CustomDocument, panel: vscode.WebviewPanel): void {
    const dist = vscode.Uri.joinPath(this.extensionUri, 'dist');
    const logo = vscode.Uri.joinPath(this.extensionUri, 'assets', 'logo.svg');
    panel.iconPath = logo;
    panel.webview.options = { enableScripts: true, localResourceRoots: [dist] };
    panel.webview.html = this.html(panel.webview, dist);

    const key = document.uri.toString();
    const entry: Entry = {
      uri: document.uri,
      panel,
      loaded: false,
      signature: null,
      pendingReveal: null,
      lastCompileStatus: { state: 'idle' },
      autoCompileMode: 'save',
      debounce: undefined,
      info: { loads: 0, numPages: 0, page: 0, zoom: 100, lastRevealedPage: null, lastError: null },
    };
    this.entries.set(key, entry);

    // A PDF outside the workspace still needs watching, which a RelativePattern allows.
    const pattern = new vscode.RelativePattern(vscode.Uri.file(path.dirname(document.uri.fsPath)), path.basename(document.uri.fsPath));
    const watcher = vscode.workspace.createFileSystemWatcher(pattern);
    const onDiskChange = () => this.scheduleReload(entry);
    const subscriptions = [
      watcher,
      watcher.onDidChange(onDiskChange),
      watcher.onDidCreate(onDiskChange),
      panel.webview.onDidReceiveMessage((message) => this.onMessage(entry, message)),
    ];

    panel.onDidDispose(() => {
      clearTimeout(entry.debounce);
      for (const subscription of subscriptions) subscription.dispose();
      this.entries.delete(key);
    });
  }

  info(uri: vscode.Uri): ViewerInfo | undefined {
    return this.entries.get(uri.toString())?.info;
  }

  isOpen(uri: vscode.Uri): boolean {
    return this.entries.has(uri.toString());
  }

  /** While a build runs its PDF is being rewritten: disk events for it are ignored. */
  setBusy(uri: vscode.Uri, busy: boolean): void {
    if (busy) this.busy.add(uri.toString());
    else this.busy.delete(uri.toString());
    const entry = this.entries.get(uri.toString());
    void entry?.panel.webview.postMessage({ type: 'busy', busy });
  }

  /** Updates the rich compilation status indicator (progress bar, pill, error badge) in the PDF tab. */
  setCompileStatus(uri: vscode.Uri, status: CompileStatus): void {
    const entry = this.entries.get(uri.toString());
    if (!entry) return;
    entry.lastCompileStatus = status;
    void entry.panel.webview.postMessage({ type: 'compileStatus', status });
  }

  /** Syncs the auto-compile toggle button state (`save` | `typing` | `off`) in the PDF tab toolbar. */
  setAutoCompile(uri: vscode.Uri, mode: string): void {
    const entry = this.entries.get(uri.toString());
    if (!entry) return;
    entry.autoCompileMode = mode;
    void entry.panel.webview.postMessage({ type: 'autoCompile', mode });
  }

  /** Sends the PDF again if it changed since the last send. */
  async refresh(uri: vscode.Uri): Promise<void> {
    const entry = this.entries.get(uri.toString());
    if (entry) await this.sendPdf(entry, false);
  }

  async open(uri: vscode.Uri): Promise<void> {
    const existing = this.entries.get(uri.toString());
    if (existing) {
      existing.panel.reveal(existing.panel.viewColumn, true);
      return;
    }
    await vscode.commands.executeCommand('vscode.openWith', uri, VIEW_TYPE, { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true });
    const started = Date.now();
    while (!this.entries.has(uri.toString()) && Date.now() - started < OPEN_TIMEOUT_MS) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  /** Scrolls the viewer to a source location, opening the tab first if needed. */
  async reveal(uri: vscode.Uri, request: RevealRequest): Promise<void> {
    await this.open(uri);
    const entry = this.entries.get(uri.toString());
    if (!entry) return;
    if (entry.loaded) void entry.panel.webview.postMessage({ type: 'reveal', ...request });
    else entry.pendingReveal = request;
  }

  /** Asks the viewer for the location in view, which comes back as an inverse search. */
  requestInverseSearch(uri: vscode.Uri): boolean {
    const entry = this.entries.get(uri.toString());
    if (!entry) return false;
    void entry.panel.webview.postMessage({ type: 'syncToCode' });
    return true;
  }

  /** Sends citation metadata, notes, and status to an open PDF tab. */
  setCitations(uri: vscode.Uri, citations: Record<string, CitationEntry>): void {
    const entry = this.entries.get(uri.toString());
    if (entry) void entry.panel.webview.postMessage({ type: 'citations', data: citations });
  }

  /** Replies to a webview request asking which .tex file owns a citation at (page, x, y). */
  sendCiteFileResolved(uri: vscode.Uri, requestId: number, file: string | null): void {
    const entry = this.entries.get(uri.toString());
    if (entry) void entry.panel.webview.postMessage({ type: 'citeFileResolved', requestId, file });
  }

  openUris(): vscode.Uri[] {
    return [...this.entries.values()].map((e) => e.uri);
  }

  activeUri(): vscode.Uri | undefined {
    for (const entry of this.entries.values()) if (entry.panel.active) return entry.uri;
    return undefined;
  }

  anyVisibleUri(): vscode.Uri | undefined {
    for (const entry of this.entries.values()) if (entry.panel.visible) return entry.uri;
    return undefined;
  }

  viewColumnOf(uri: vscode.Uri): vscode.ViewColumn | undefined {
    return this.entries.get(uri.toString())?.panel.viewColumn;
  }

  private scheduleReload(entry: Entry): void {
    if (this.busy.has(entry.uri.toString())) return;
    clearTimeout(entry.debounce);
    entry.debounce = setTimeout(() => void this.sendPdf(entry, false), WATCH_DEBOUNCE_MS);
  }

  private async sendPdf(entry: Entry, force: boolean): Promise<void> {
    let signature: string;
    let bytes: Uint8Array;
    try {
      const stat = await fs.stat(entry.uri.fsPath);
      signature = `${stat.mtimeMs}:${stat.size}`;
      if (!force && signature === entry.signature) return;
      bytes = new Uint8Array(await fs.readFile(entry.uri.fsPath));
    } catch {
      entry.signature = null;
      void entry.panel.webview.postMessage({ type: 'noPdf' });
      return;
    }
    entry.signature = signature;
    void entry.panel.webview.postMessage({ type: 'pdf', data: bytes });
  }

  private onMessage(entry: Entry, message: any): void {
    switch (message.type) {
      case 'ready':
        // Also sent when a hidden tab comes back, since its webview was destroyed.
        entry.loaded = false;
        void this.sendPdf(entry, true);
        void entry.panel.webview.postMessage({ type: 'busy', busy: this.busy.has(entry.uri.toString()) });
        if (entry.lastCompileStatus.state !== 'idle') {
          void entry.panel.webview.postMessage({ type: 'compileStatus', status: entry.lastCompileStatus });
        }
        void entry.panel.webview.postMessage({ type: 'autoCompile', mode: entry.autoCompileMode });
        this.ready.fire(entry.uri);
        break;
      case 'loaded':
        entry.loaded = true;
        entry.info.loads++;
        entry.info.numPages = message.numPages;
        entry.info.lastError = null;
        if (entry.pendingReveal) {
          void entry.panel.webview.postMessage({ type: 'reveal', ...entry.pendingReveal });
          entry.pendingReveal = null;
        }
        break;
      case 'state':
        entry.info.page = message.page;
        entry.info.zoom = message.zoom;
        break;
      case 'revealed':
        entry.info.lastRevealedPage = message.page;
        break;
      case 'loadFailed':
        entry.info.lastError = String(message.message);
        // The next change on disk may be a complete file again.
        entry.signature = null;
        break;
      case 'inverseSearch':
        this.inverseSearch.fire({
          uri: entry.uri,
          request: { page: message.page, x: message.x, y: message.y, word: message.word ?? '', context: message.context ?? '' },
        });
        break;
      case 'compile':
        void vscode.commands.executeCommand('openScriptorium.compile');
        break;
      case 'toggleAutoCompile':
        this.toggleAutoCompile.fire(entry.uri);
        break;
      case 'showLog':
        this.showLog.fire(entry.uri);
        break;
      case 'openExternal': {
        const rawUrl = typeof message.url === 'string' ? message.url.trim() : '';
        if (/^(https?:|mailto:)/i.test(rawUrl)) {
          void vscode.env.openExternal(vscode.Uri.parse(rawUrl));
        }
        break;
      }
      case 'resolveCiteFile':
        this.resolveCiteFile.fire({
          uri: entry.uri,
          request: { requestId: Number(message.requestId), page: Number(message.page), x: Number(message.x), y: Number(message.y) },
        });
        break;
    }
  }

  private html(webview: vscode.Webview, dist: vscode.Uri): string {
    const nonce = crypto.randomBytes(16).toString('hex');
    const uri = (...parts: string[]) => webview.asWebviewUri(vscode.Uri.joinPath(dist, ...parts)).toString();
    const config = {
      workerUrl: uri('pdfjs', 'pdf.worker.min.mjs'),
      wasmUrl: `${uri('pdfjs', 'wasm')}/`,
      iccUrl: `${uri('pdfjs', 'iccs')}/`,
      standardFontDataUrl: `${uri('pdfjs', 'standard_fonts')}/`,
      cMapUrl: `${uri('pdfjs', 'cmaps')}/`,
    };
    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} data: blob:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `font-src ${webview.cspSource} data: blob:`,
      `connect-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}' 'wasm-unsafe-eval' ${webview.cspSource}`,
      `worker-src blob:`,
    ].join('; ');
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <link rel="stylesheet" href="${uri('pdfjs', 'pdf_viewer.css')}">
  <link rel="stylesheet" href="${uri('viewer.css')}">
</head>
<body>
  <div id="toolbar" role="toolbar" aria-label="PDF controls">
    <div class="group">
      <button id="toggle-outline" title="Toggle outline navigator" aria-label="Toggle outline navigator" aria-pressed="false">&#9776;</button>
      <button id="prev" title="Previous page" aria-label="Previous page">&#8249;</button>
      <input id="page" type="number" min="1" value="1" aria-label="Page number">
      <span id="total">/ 0</span>
      <button id="next" title="Next page" aria-label="Next page">&#8250;</button>
    </div>
    <div class="group">
      <button id="zoom-out" title="Zoom out" aria-label="Zoom out">&minus;</button>
      <span id="zoom">100%</span>
      <button id="zoom-in" title="Zoom in" aria-label="Zoom in">+</button>
      <button id="fit" title="Fit width">Fit</button>
      <button id="toggle-find" title="Find in PDF (Ctrl+F)" aria-label="Find in PDF">Find</button>
    </div>
    <div class="group end">
      <button id="compile-status" class="status-pill" hidden title="Compilation status"></button>
      <span id="message" role="status"></span>
      <button id="auto-compile" class="toggle-btn" title="Auto-compile when saving LaTeX files in this project" aria-pressed="true"><span class="dot"></span>Auto</button>
      <button id="to-code" title="Go to this location in the source">Source</button>
      <button id="compile" title="Compile the document">Compile</button>
    </div>
  </div>
  <div id="compile-bar" hidden aria-hidden="true"><div class="compile-bar-fill"></div></div>
  <div id="workspace">
    <aside id="outline-panel" hidden aria-label="Document outline">
      <div id="outline-header">
        <span>Outline</span>
        <button id="outline-close" title="Close outline" aria-label="Close outline">&times;</button>
      </div>
      <div id="outline-tree"></div>
    </aside>
    <div id="outline-resizer" hidden role="separator" aria-orientation="vertical" aria-label="Resize outline" title="Drag to resize outline (double-click to reset)"></div>
    <div id="viewer-wrap">
      <div id="find-bar" hidden role="search" aria-label="Find in PDF">
        <input id="find-input" type="text" placeholder="Find in PDF…" aria-label="Find text">
        <span id="find-count"></span>
        <button id="find-case" class="toggle-btn" title="Match case" aria-pressed="false">Aa</button>
        <button id="find-prev" title="Previous match (Shift+Enter)" aria-label="Previous match">&#9650;</button>
        <button id="find-next" title="Next match (Enter)" aria-label="Next match">&#9660;</button>
        <button id="find-close" title="Close (Esc)" aria-label="Close find bar">&times;</button>
      </div>
      <div id="viewer" title="Double-click to jump to the source"></div>
      <div id="empty" hidden>No PDF yet. Compile the document to create it.</div>
    </div>
  </div>
  <script id="config" type="application/json">${JSON.stringify(config)}</script>
  <script nonce="${nonce}" type="module" src="${uri('viewer.mjs')}"></script>
</body>
</html>`;
  }
}

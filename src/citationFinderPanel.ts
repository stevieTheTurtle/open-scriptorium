// Side-panel webview for "Find Supporting Citation in Zotero":
// displays ranked passages with verbatim quotes, page numbers, @citekeys, and
// one-click actions to insert \cite{key} and append evidence notes to references.notes.json.

import * as vscode from 'vscode';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { parseBib, type BibFields } from './bib.ts';
import {
  appendEvidenceNoteJson,
  cleanClaimText,
  computeCiteInsertion,
  matchBibKeyForPaper,
  type FindSupportResponse,
  type SupportCandidate,
} from './citationFinder.ts';
import { CONFIG_SECTION, type Project } from './project.ts';
import type { ResearchAssistantService } from './researchAssistant.ts';

export interface CitationAnchor {
  uri: vscode.Uri;
  line: number;
  endCharacter: number;
  relativeFile: string;
  source: 'tex' | 'pdf';
}

interface EnrichedCandidate extends SupportCandidate {
  resolvedKey: string;
  inBib: boolean;
}

const EXCLUDED_BIB = '**/{node_modules,.git,_Old,.scriptorium}/**';
const FLASH_MS = 1600;

export class CitationFinderPanel implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private readonly extensionUri: vscode.Uri;
  private readonly researchAssistant: ResearchAssistantService;
  private readonly onNotesUpdated: () => void;
  private readonly insertFlash: vscode.TextEditorDecorationType;

  private anchor: CitationAnchor | null = null;
  private project: Project | null = null;
  private rawClaim = '';
  private cleanedClaim = '';
  private useReranker = true;
  private lastResponse: FindSupportResponse | null = null;
  private enriched: EnrichedCandidate[] = [];
  private searchSeq = 0;

  constructor(
    extensionUri: vscode.Uri,
    researchAssistant: ResearchAssistantService,
    onNotesUpdated: () => void,
  ) {
    this.extensionUri = extensionUri;
    this.researchAssistant = researchAssistant;
    this.onNotesUpdated = onNotesUpdated;
    this.insertFlash = vscode.window.createTextEditorDecorationType({
      backgroundColor: new vscode.ThemeColor('editor.findMatchHighlightBackground'),
    });
  }

  dispose(): void {
    this.panel?.dispose();
    this.insertFlash.dispose();
  }

  async openAndSearch(options: {
    rawClaim: string;
    anchor: CitationAnchor | null;
    project: Project | null;
  }): Promise<void> {
    this.anchor = options.anchor;
    this.project = options.project;
    this.rawClaim = options.rawClaim;
    this.cleanedClaim = cleanClaimText(options.rawClaim) || options.rawClaim.trim();

    this.ensurePanel();
    await this.runSearch(this.cleanedClaim, this.useReranker);
  }

  private ensurePanel(): void {
    if (this.panel) {
      this.panel.reveal(this.panel.viewColumn ?? vscode.ViewColumn.Beside, false);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'openScriptorium.citationFinder',
      'Citation Finder — Zotero',
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false },
      { enableScripts: true, retainContextWhenHidden: true },
    );
    panel.iconPath = vscode.Uri.joinPath(this.extensionUri, 'assets', 'logo.svg');
    panel.webview.html = this.buildHtml(panel.webview);

    panel.webview.onDidReceiveMessage((msg) => {
      void this.handleMessage(msg);
    });
    panel.onDidDispose(() => {
      if (this.panel === panel) this.panel = undefined;
    });
    this.panel = panel;
  }

  private citeCommand(): string {
    const cfg = vscode.workspace.getConfiguration(CONFIG_SECTION, this.project?.folder?.uri);
    return cfg.get<string>('citations.citeCommand', '\\cite');
  }

  private rerankerModel(): string {
    const cfg = vscode.workspace.getConfiguration(CONFIG_SECTION, this.project?.folder?.uri);
    return cfg.get<string>('researchAssistant.rerankerModel', 'cross-encoder/ms-marco-MiniLM-L-6-v2');
  }

  private async resolveNotesPath(): Promise<string | null> {
    const project = this.project;
    const folderPath = project?.folder?.uri.fsPath ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!project && !folderPath) return null;

    const cfg = vscode.workspace.getConfiguration(CONFIG_SECTION, project?.folder?.uri);
    const configured = cfg.get<string>('citations.notesFile', '').trim();
    if (configured) {
      return path.isAbsolute(configured)
        ? configured
        : path.join(folderPath ?? project!.mainDir, configured);
    }

    if (project) {
      const bibUris = await vscode.workspace.findFiles(
        new vscode.RelativePattern(vscode.Uri.file(project.mainDir), '**/*.bib'),
        EXCLUDED_BIB,
        10,
      );
      if (bibUris.length) {
        bibUris.sort((a, b) => a.fsPath.localeCompare(b.fsPath));
        return bibUris[0].fsPath.replace(/\.bib$/i, '.notes.json');
      }
    }
    return path.join(folderPath ?? project!.mainDir, 'references.notes.json');
  }

  private async loadProjectBib(): Promise<Map<string, BibFields>> {
    const bib = new Map<string, BibFields>();
    if (!this.project) return bib;
    const bibUris = await vscode.workspace.findFiles(
      new vscode.RelativePattern(vscode.Uri.file(this.project.mainDir), '**/*.bib'),
      EXCLUDED_BIB,
      100,
    );
    for (const uri of bibUris.sort((a, b) => a.fsPath.localeCompare(b.fsPath))) {
      try {
        const text = await fs.readFile(uri.fsPath, 'utf8');
        for (const [k, v] of parseBib(text)) {
          if (!bib.has(k)) bib.set(k, v);
        }
      } catch {
        // ignore unreadable bib file
      }
    }
    return bib;
  }

  private async runSearch(claim: string, useReranker: boolean): Promise<void> {
    const seq = ++this.searchSeq;
    this.cleanedClaim = claim.trim();
    this.useReranker = useReranker;
    const notesPath = await this.resolveNotesPath();
    const workspaceRoot = this.project?.folder?.uri.fsPath ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
    const notesDisplay = notesPath && workspaceRoot ? path.relative(workspaceRoot, notesPath).replaceAll('\\', '/') : (notesPath ?? '');

    void this.panel?.webview.postMessage({
      type: 'loading',
      claim: this.cleanedClaim,
      citeCmd: this.citeCommand(),
      useReranker,
      anchor: this.anchor
        ? { file: this.anchor.relativeFile, line: this.anchor.line + 1, source: this.anchor.source }
        : null,
      notesFile: notesDisplay,
    });

    if (!this.cleanedClaim) {
      void this.panel?.webview.postMessage({
        type: 'error',
        message: 'Enter or select a claim to search your Zotero library.',
      });
      return;
    }

    const res = await this.researchAssistant.findSupportingCitations(this.cleanedClaim, {
      topK: 8,
      recallK: 30,
      useReranker,
      rerankerModel: this.rerankerModel(),
    });
    if (seq !== this.searchSeq) return;

    if (!res.ok || !res.data) {
      void this.panel?.webview.postMessage({
        type: 'error',
        message: res.error ?? 'Research Assistant search failed.',
        needsSetup: Boolean(res.needsSetup),
      });
      return;
    }

    this.lastResponse = res.data;
    const bib = await this.loadProjectBib();
    this.enriched = res.data.results.map((item) => {
      let resolvedKey = item.citekey?.trim() || '';
      if (!resolvedKey) {
        resolvedKey = matchBibKeyForPaper(item.title, item.authors, bib) ?? '';
      }
      const inBib = Boolean(resolvedKey && bib.has(resolvedKey));
      return { ...item, resolvedKey, inBib };
    });

    void this.panel?.webview.postMessage({
      type: 'results',
      claim: res.data.claim,
      reranker: res.data.reranker,
      collection: res.data.collection,
      elapsedMs: res.data.elapsed_ms,
      results: this.enriched,
    });
  }

  private async handleMessage(msg: any): Promise<void> {
    switch (msg?.type) {
      case 'search': {
        const claim = typeof msg.claim === 'string' ? msg.claim : '';
        const useReranker = msg.useReranker !== false;
        await this.runSearch(claim, useReranker);
        break;
      }
      case 'runSetup':
        await this.researchAssistant.setupWizard();
        break;
      case 'revealAnchor':
        if (this.anchor) {
          const doc = await vscode.workspace.openTextDocument(this.anchor.uri);
          const pos = new vscode.Position(this.anchor.line, this.anchor.endCharacter);
          const editor = await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.One, preserveFocus: false });
          editor.selection = new vscode.Selection(pos, pos);
          editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
        }
        break;
      case 'openPdf': {
        const filePath = typeof msg.filePath === 'string' ? msg.filePath : '';
        if (filePath) {
          await vscode.env.openExternal(vscode.Uri.file(filePath));
        }
        break;
      }
      case 'copyCite': {
        const key = String(msg.citeKey ?? '').trim().replace(/^@/, '');
        const citeCmd = String(msg.citeCmd ?? this.citeCommand()).trim() || '\\cite';
        if (!key) {
          void vscode.window.showWarningMessage('Enter a BibTeX citation key first.');
          return;
        }
        const snippet = `${citeCmd}{${key}}`;
        await vscode.env.clipboard.writeText(snippet);
        void vscode.window.setStatusBarMessage(`Open Scriptorium: Copied ${snippet}`, 3000);
        break;
      }
      case 'saveNote':
      case 'insertAndSave': {
        const index = Number(msg.index);
        const item = this.enriched[index];
        if (!item) return;

        let citeKey = String(msg.citeKey ?? item.resolvedKey ?? '').trim().replace(/^@/, '');
        if (!citeKey) {
          const prompted = await vscode.window.showInputBox({
            title: 'Citation Key (BibTeX)',
            prompt: `This paper has no @citekey tag in Zotero. Enter the BibTeX key for "${item.title}":`,
            placeHolder: 'e.g. vaswani2017attention',
          });
          if (!prompted?.trim()) return;
          citeKey = prompted.trim().replace(/^@/, '');
        }

        const citeCmd = String(msg.citeCmd ?? this.citeCommand()).trim() || '\\cite';
        const quote = String(msg.quote ?? item.quote ?? '').trim();
        const claim = this.cleanedClaim || this.rawClaim.trim();

        let inserted = false;
        let alreadyPresent = false;
        if (msg.type === 'insertAndSave') {
          if (this.anchor) {
            const insertRes = await this.insertCiteAtAnchor(this.anchor, citeKey, citeCmd);
            inserted = insertRes.inserted;
            alreadyPresent = insertRes.alreadyPresent;
          } else {
            const snippet = `${citeCmd}{${citeKey}}`;
            await vscode.env.clipboard.writeText(snippet);
          }
        }

        const saved = await this.saveEvidenceNote(citeKey, {
          quote,
          page: item.page,
          file: this.anchor?.relativeFile ?? '',
          claim,
          paper_id: item.paper_id,
        });

        void this.panel?.webview.postMessage({
          type: 'actionDone',
          index,
          citeKey,
          action: msg.type,
          inserted,
          alreadyPresent,
          copiedFallback: msg.type === 'insertAndSave' && !this.anchor,
          duplicateNote: saved.duplicate,
          notesPath: saved.notesDisplay,
        });

        const parts: string[] = [];
        if (msg.type === 'insertAndSave') {
          if (inserted) parts.push(`inserted ${citeCmd}{${citeKey}}`);
          else if (alreadyPresent) parts.push(`${citeKey} already cited here`);
          else parts.push(`copied ${citeCmd}{${citeKey}}`);
        }
        parts.push(saved.duplicate ? 'note already recorded' : `saved evidence note`);
        void vscode.window.setStatusBarMessage(`Open Scriptorium: ${parts.join(' · ')}`, 4000);
        break;
      }
    }
  }

  private async insertCiteAtAnchor(
    anchor: CitationAnchor,
    citeKey: string,
    citeCmd: string,
  ): Promise<{ inserted: boolean; alreadyPresent: boolean }> {
    const doc = await vscode.workspace.openTextDocument(anchor.uri);
    const lineIdx = Math.max(0, Math.min(anchor.line, doc.lineCount - 1));
    const lineText = doc.lineAt(lineIdx).text;
    const plan = computeCiteInsertion(lineText, anchor.endCharacter, citeKey, citeCmd);

    if (plan.alreadyPresent) {
      return { inserted: false, alreadyPresent: true };
    }

    const range = new vscode.Range(
      new vscode.Position(lineIdx, plan.replaceStart),
      new vscode.Position(lineIdx, plan.replaceEnd),
    );
    const edit = new vscode.WorkspaceEdit();
    edit.replace(anchor.uri, range, plan.insertText);
    const applied = await vscode.workspace.applyEdit(edit);
    if (applied) {
      // Advance anchor so inserting a second supporting citation merges cleanly into the same \cite{...}!
      anchor.endCharacter = plan.replaceStart + plan.insertText.length;
      const showing = vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === anchor.uri.toString());
      const editor =
        showing ??
        (await vscode.window.showTextDocument(doc, {
          viewColumn: vscode.ViewColumn.One,
          preserveFocus: true,
        }));
      const flashRange = new vscode.Range(
        new vscode.Position(lineIdx, plan.replaceStart),
        new vscode.Position(lineIdx, plan.replaceStart + plan.insertText.length),
      );
      editor.revealRange(flashRange, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
      editor.setDecorations(this.insertFlash, [flashRange]);
      setTimeout(() => editor.setDecorations(this.insertFlash, []), FLASH_MS);
    }
    return { inserted: applied, alreadyPresent: false };
  }

  private async saveEvidenceNote(
    citeKey: string,
    note: { quote: string; page?: number; file?: string; claim?: string; paper_id?: string },
  ): Promise<{ duplicate: boolean; notesDisplay: string }> {
    const notesPath = await this.resolveNotesPath();
    if (!notesPath) {
      throw new Error('Could not determine a target references.notes.json path.');
    }
    let existing: string | null = null;
    try {
      existing = await fs.readFile(notesPath, 'utf8');
    } catch {
      existing = null;
    }
    const updated = appendEvidenceNoteJson(existing, citeKey, note);
    if (!updated.duplicate) {
      await fs.mkdir(path.dirname(notesPath), { recursive: true });
      const tmp = `${notesPath}.${process.pid}.tmp`;
      await fs.writeFile(tmp, updated.json, 'utf8');
      await fs.rename(tmp, notesPath);
      this.onNotesUpdated();
    }
    const workspaceRoot = this.project?.folder?.uri.fsPath ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
    const notesDisplay = workspaceRoot ? path.relative(workspaceRoot, notesPath).replaceAll('\\', '/') : notesPath;
    return { duplicate: updated.duplicate, notesDisplay };
  }

  private buildHtml(webview: vscode.Webview): string {
    const nonce = crypto.randomBytes(16).toString('hex');
    const csp = [
      `default-src 'none'`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
    ].join('; ');

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 12px 14px 28px;
    background: var(--vscode-editor-background);
    color: var(--vscode-foreground);
    font: 13px/1.45 var(--vscode-font-family);
  }
  .header {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding-bottom: 10px;
    border-bottom: 1px solid var(--vscode-editorWidget-border, rgba(128,128,128,0.28));
  }
  .title-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }
  .title-row h2 {
    margin: 0;
    font-size: 13px;
    font-weight: 600;
    letter-spacing: 0.02em;
    text-transform: uppercase;
    color: var(--vscode-descriptionForeground);
  }
  .controls-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    font-size: 12px;
  }
  textarea#claim {
    width: 100%;
    min-height: 54px;
    max-height: 140px;
    resize: vertical;
    padding: 7px 9px;
    font: 12.5px/1.4 var(--vscode-font-family);
    color: var(--vscode-input-foreground);
    background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, rgba(128,128,128,0.35));
    border-radius: 4px;
  }
  textarea#claim:focus, select:focus, input.key-input:focus, textarea.quote-edit:focus {
    outline: 1px solid var(--vscode-focusBorder);
  }
  select, input.key-input {
    height: 24px;
    padding: 0 6px;
    font: 12px var(--vscode-font-family);
    color: var(--vscode-input-foreground);
    background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, rgba(128,128,128,0.35));
    border-radius: 3px;
  }
  button {
    height: 26px;
    padding: 0 10px;
    border-radius: 3px;
    border: 1px solid transparent;
    font: 12px var(--vscode-font-family);
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    gap: 5px;
    background: var(--vscode-button-secondaryBackground, rgba(128,128,128,0.22));
    color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
  }
  button:hover { background: var(--vscode-button-secondaryHoverBackground, rgba(128,128,128,0.34)); }
  button.primary {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    font-weight: 500;
  }
  button.primary:hover { background: var(--vscode-button-hoverBackground); }
  button.link-btn {
    height: auto;
    padding: 0 3px;
    background: transparent;
    color: var(--vscode-textLink-foreground);
    text-decoration: underline;
  }
  label.check {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    cursor: pointer;
    color: var(--vscode-descriptionForeground);
  }
  .meta-bar {
    display: flex;
    flex-wrap: wrap;
    gap: 8px 14px;
    margin-top: 8px;
    font-size: 11.5px;
    color: var(--vscode-descriptionForeground);
  }
  .status-banner {
    margin-top: 12px;
    padding: 10px 12px;
    border-radius: 5px;
    background: var(--vscode-editorWidget-background, rgba(128,128,128,0.12));
    border: 1px solid var(--vscode-editorWidget-border, rgba(128,128,128,0.28));
    color: var(--vscode-foreground);
  }
  .status-banner.error {
    border-color: rgba(239, 68, 68, 0.55);
    background: rgba(239, 68, 68, 0.12);
  }
  .results {
    display: flex;
    flex-direction: column;
    gap: 10px;
    margin-top: 12px;
  }
  .card {
    border: 1px solid var(--vscode-editorWidget-border, rgba(128,128,128,0.3));
    border-radius: 6px;
    padding: 10px 12px;
    background: var(--vscode-editorWidget-background, rgba(128,128,128,0.06));
  }
  .card-top {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 8px;
  }
  .card-title {
    font-weight: 600;
    font-size: 13px;
    line-height: 1.35;
  }
  .card-authors {
    margin-top: 2px;
    font-size: 11.5px;
    color: var(--vscode-descriptionForeground);
  }
  .score-pill {
    flex-shrink: 0;
    padding: 2px 7px;
    border-radius: 10px;
    font-size: 11px;
    font-weight: 600;
    border: 1px solid transparent;
  }
  .score-high { background: rgba(34,197,94,0.16); border-color: rgba(34,197,94,0.45); color: #4ade80; }
  .score-mid  { background: rgba(245,158,11,0.16); border-color: rgba(245,158,11,0.45); color: #fbbf24; }
  .score-low  { background: rgba(148,163,184,0.16); border-color: rgba(148,163,184,0.4); color: var(--vscode-descriptionForeground); }
  .tags-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
    margin-top: 6px;
    font-size: 11px;
  }
  .badge {
    padding: 1px 6px;
    border-radius: 3px;
    background: rgba(59,130,246,0.15);
    border: 1px solid rgba(59,130,246,0.35);
    font-family: var(--vscode-editor-font-family, monospace);
  }
  .badge.ok { background: rgba(34,197,94,0.14); border-color: rgba(34,197,94,0.38); color: #4ade80; font-family: inherit; }
  .badge.warn { background: rgba(245,158,11,0.14); border-color: rgba(245,158,11,0.4); color: #fbbf24; font-family: inherit; }
  .badge.page { background: rgba(148,163,184,0.14); border-color: rgba(148,163,184,0.35); color: var(--vscode-foreground); }
  blockquote.quote {
    margin: 8px 0 0;
    padding: 6px 10px;
    border-left: 3px solid var(--vscode-textLink-foreground, #3b82f6);
    background: var(--vscode-editor-background);
    border-radius: 0 4px 4px 0;
    font-style: italic;
    font-size: 12.5px;
    line-height: 1.48;
  }
  textarea.quote-edit {
    width: 100%;
    min-height: 58px;
    margin-top: 8px;
    padding: 6px 8px;
    font: italic 12.5px/1.45 var(--vscode-font-family);
    color: var(--vscode-input-foreground);
    background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, rgba(128,128,128,0.4));
    border-radius: 4px;
  }
  details.chunk {
    margin-top: 6px;
    font-size: 11.5px;
    color: var(--vscode-descriptionForeground);
  }
  details.chunk summary { cursor: pointer; user-select: none; }
  details.chunk p {
    margin: 5px 0 0;
    padding: 6px 8px;
    background: var(--vscode-editor-background);
    border-radius: 4px;
    line-height: 1.45;
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
    margin-top: 9px;
  }
  .done-msg {
    font-size: 11.5px;
    color: #4ade80;
    margin-left: 4px;
  }
  input.key-input { width: 170px; font-family: var(--vscode-editor-font-family, monospace); }
</style>
</head>
<body>
  <div class="header">
    <div class="title-row">
      <h2>Find Supporting Citation in Zotero</h2>
      <div class="controls-row">
        <select id="cite-cmd" title="LaTeX citation command">
          <option value="\\cite">\\cite</option>
          <option value="\\citep">\\citep</option>
          <option value="\\citet">\\citet</option>
          <option value="\\parencite">\\parencite</option>
          <option value="\\textcite">\\textcite</option>
          <option value="\\autocite">\\autocite</option>
        </select>
        <label class="check" title="Use local CrossEncoder reranker (recommended)">
          <input type="checkbox" id="use-reranker" checked> Rerank
        </label>
        <button id="search-btn" class="primary">Search</button>
      </div>
    </div>
    <textarea id="claim" placeholder="Selected claim or prose to find supporting citations for…"></textarea>
    <div id="meta-bar" class="meta-bar"></div>
  </div>
  <div id="status"></div>
  <div id="results" class="results"></div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const claimEl = document.getElementById('claim');
    const citeCmdEl = document.getElementById('cite-cmd');
    const rerankEl = document.getElementById('use-reranker');
    const searchBtn = document.getElementById('search-btn');
    const metaBar = document.getElementById('meta-bar');
    const statusEl = document.getElementById('status');
    const resultsEl = document.getElementById('results');

    let state = { anchor: null, notesFile: '', results: [] };

    function esc(s) {
      return String(s ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;');
    }

    function triggerSearch() {
      vscode.postMessage({
        type: 'search',
        claim: claimEl.value,
        useReranker: rerankEl.checked,
      });
    }

    searchBtn.addEventListener('click', triggerSearch);
    claimEl.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        triggerSearch();
      }
    });

    function renderMeta(extra = '') {
      const parts = [];
      if (state.anchor) {
        parts.push(\`Target: <button class="link-btn" id="reveal-anchor">\${esc(state.anchor.file)}:\${state.anchor.line}</button>\`);
      } else {
        parts.push('Target: clipboard (no .tex cursor)');
      }
      if (state.notesFile) {
        parts.push(\`Notes: <code>\${esc(state.notesFile)}</code>\`);
      }
      if (extra) parts.push(extra);
      metaBar.innerHTML = parts.join(' &middot; ');
      const btn = document.getElementById('reveal-anchor');
      if (btn) btn.addEventListener('click', () => vscode.postMessage({ type: 'revealAnchor' }));
    }

    function scoreClass(score) {
      if (score >= 0.7) return 'score-high';
      if (score >= 0.4) return 'score-mid';
      return 'score-low';
    }

    function renderResults(items) {
      resultsEl.innerHTML = '';
      if (!items.length) {
        statusEl.innerHTML = '<div class="status-banner">No matching passages found in your Zotero index. Try rephrasing the claim or syncing Zotero.</div>';
        return;
      }
      statusEl.innerHTML = '';
      const citeCmd = citeCmdEl.value || '\\\\cite';

      items.forEach((item, idx) => {
        const card = document.createElement('div');
        card.className = 'card';
        card.dataset.index = String(idx);

        const pct = Math.round((Number(item.score) || 0) * 100);
        const authors = Array.isArray(item.authors) && item.authors.length
          ? item.authors.slice(0, 4).join(', ') + (item.authors.length > 4 ? ' et al.' : '')
          : 'Unknown author';
        const yearStr = item.year ? \` (\${item.year})\` : '';
        const keyVal = item.resolvedKey || '';

        const keyBadgeHtml = keyVal
          ? \`<span class="badge">@\${esc(keyVal)}</span>\` +
            (item.inBib
              ? '<span class="badge ok">In .bib &#10003;</span>'
              : '<span class="badge warn" title="Not found in current workspace .bib files">Not in .bib</span>')
          : \`<input class="key-input" data-role="key" placeholder="Enter BibTeX key…" value="">\` +
            '<span class="badge warn">No @citekey tag</span>';

        const pageHtml = item.page ? \`<span class="badge page">p. \${item.page}</span>\` : '';
        const primaryLabel = state.anchor
          ? \`Insert \${esc(citeCmd)} &amp; Save Note\`
          : \`Copy \${esc(citeCmd)} &amp; Save Note\`;

        card.innerHTML = \`
          <div class="card-top">
            <div>
              <div class="card-title">#\${idx + 1} \${esc(item.title)}\${esc(yearStr)}</div>
              <div class="card-authors">\${esc(authors)}</div>
            </div>
            <span class="score-pill \${scoreClass(item.score)}" title="Local relevance/support score">\${pct}%</span>
          </div>
          <div class="tags-row">
            \${keyBadgeHtml}
            \${pageHtml}
          </div>
          <blockquote class="quote" data-role="quote-view">&ldquo;\${esc(item.quote)}&rdquo;</blockquote>
          <textarea class="quote-edit" data-role="quote-edit" hidden>\${esc(item.quote)}</textarea>
          <details class="chunk">
            <summary>Show surrounding chunk</summary>
            <p>\${esc(item.chunk)}</p>
          </details>
          <div class="actions">
            <button class="primary" data-action="insertAndSave">\${primaryLabel}</button>
            <button data-action="saveNote">Save Note Only</button>
            <button data-action="copyCite">Copy \${esc(citeCmd)}</button>
            <button data-action="toggleEdit">Edit Quote</button>
            \${item.file_path ? '<button data-action="openPdf">Open PDF</button>' : ''}
            <span class="done-msg" data-role="done"></span>
          </div>
        \`;

        const getKey = () => {
          const inp = card.querySelector('input[data-role="key"]');
          return inp ? inp.value.trim() : keyVal;
        };
        const getQuote = () => {
          const ed = card.querySelector('textarea[data-role="quote-edit"]');
          return ed ? ed.value.trim() : item.quote;
        };

        card.querySelector('[data-action="insertAndSave"]').addEventListener('click', () => {
          vscode.postMessage({ type: 'insertAndSave', index: idx, citeKey: getKey(), citeCmd: citeCmdEl.value, quote: getQuote() });
        });
        card.querySelector('[data-action="saveNote"]').addEventListener('click', () => {
          vscode.postMessage({ type: 'saveNote', index: idx, citeKey: getKey(), citeCmd: citeCmdEl.value, quote: getQuote() });
        });
        card.querySelector('[data-action="copyCite"]').addEventListener('click', () => {
          vscode.postMessage({ type: 'copyCite', citeKey: getKey(), citeCmd: citeCmdEl.value });
        });
        const toggleBtn = card.querySelector('[data-action="toggleEdit"]');
        toggleBtn.addEventListener('click', () => {
          const viewEl = card.querySelector('[data-role="quote-view"]');
          const editEl = card.querySelector('[data-role="quote-edit"]');
          const editing = editEl.hidden;
          editEl.hidden = !editing;
          viewEl.hidden = editing;
          toggleBtn.textContent = editing ? 'Done Editing' : 'Edit Quote';
          if (!editing) viewEl.innerHTML = '&ldquo;' + esc(editEl.value.trim()) + '&rdquo;';
        });
        const pdfBtn = card.querySelector('[data-action="openPdf"]');
        if (pdfBtn) {
          pdfBtn.addEventListener('click', () => vscode.postMessage({ type: 'openPdf', filePath: item.file_path }));
        }
        resultsEl.appendChild(card);
      });
    }

    citeCmdEl.addEventListener('change', () => {
      if (state.results.length) renderResults(state.results);
    });

    window.addEventListener('message', (event) => {
      const m = event.data;
      if (m.type === 'loading') {
        claimEl.value = m.claim || '';
        if (m.citeCmd) citeCmdEl.value = m.citeCmd;
        rerankEl.checked = m.useReranker !== false;
        state.anchor = m.anchor || null;
        state.notesFile = m.notesFile || '';
        state.results = [];
        renderMeta();
        resultsEl.innerHTML = '';
        statusEl.innerHTML = '<div class="status-banner">Searching Zotero library and reranking passages locally…' +
          (rerankEl.checked ? ' <span style="opacity:0.75">(first run caches the local CrossEncoder model once)</span>' : '') +
          '</div>';
      } else if (m.type === 'error') {
        resultsEl.innerHTML = '';
        const setupBtn = m.needsSetup ? ' <button id="run-setup-btn" class="primary" style="margin-left:8px">Run Setup</button>' : '';
        statusEl.innerHTML = \`<div class="status-banner error">\${esc(m.message)}\${setupBtn}</div>\`;
        const b = document.getElementById('run-setup-btn');
        if (b) b.addEventListener('click', () => vscode.postMessage({ type: 'runSetup' }));
      } else if (m.type === 'results') {
        state.results = m.results || [];
        const rerankerLabel = m.reranker === 'fallback' ? 'hybrid+lexical fallback' : m.reranker;
        renderMeta(\`\${state.results.length} papers · \${esc(rerankerLabel)} · \${m.elapsedMs} ms\`);
        renderResults(state.results);
      } else if (m.type === 'actionDone') {
        const card = resultsEl.querySelector(\`.card[data-index="\${m.index}"]\`);
        if (card) {
          const done = card.querySelector('[data-role="done"]');
          if (done) {
            const parts = [];
            if (m.action === 'insertAndSave') {
              if (m.inserted) parts.push('Inserted');
              else if (m.alreadyPresent) parts.push('Already cited');
              else if (m.copiedFallback) parts.push('Copied');
            }
            parts.push(m.duplicateNote ? 'Note exists' : 'Note saved');
            done.textContent = '✓ ' + parts.join(' & ');
          }
        }
      }
    });
  </script>
</body>
</html>`;
  }
}

import * as vscode from 'vscode';
import * as path from 'node:path';
import { CitationService } from './citationService.ts';
import { EditingFeatures } from './editing.ts';
import { CONFIG_SECTION, ProjectResolver } from './project.ts';
import { ResearchAssistantService } from './researchAssistant.ts';
import { cleanWord, findWordNear } from './reveal.ts';
import { CompileSession } from './session.ts';
import { loadSyncTex } from './synctex.ts';
import { PdfViewer, VIEW_TYPE, type InverseSearchRequest, type ResolveCiteFileRequest } from './viewer.ts';

const SAVE_DEBOUNCE_MS = 300;
const FLASH_MS = 1800;
const LATEX_FILE = /\.(tex|bib|cls|sty|bbl)$/i;

/** Returned from activate; the end-to-end tests drive the extension through it. */
export interface ExtensionApi {
  session: CompileSession;
  viewer: PdfViewer;
  projects: ProjectResolver;
  editing: EditingFeatures;
  inverseSearch(uri: vscode.Uri, request: InverseSearchRequest): Promise<void>;
}

export function activate(context: vscode.ExtensionContext): ExtensionApi {
  const viewer = new PdfViewer(context.extensionUri);
  const projects = new ProjectResolver(context.workspaceState);
  const session = new CompileSession(projects, viewer);
  const editing = new EditingFeatures(projects);
  const researchAssistant = new ResearchAssistantService(context);
  const citations = new CitationService(researchAssistant);
  const lineFlash = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: new vscode.ThemeColor('editor.rangeHighlightBackground'),
  });
  const wordFlash = vscode.window.createTextEditorDecorationType({
    backgroundColor: new vscode.ThemeColor('editor.findMatchHighlightBackground'),
  });

  const status = (text: string) => vscode.window.setStatusBarMessage(`Open Scriptorium: ${text}`, 4000);

  async function compile(options: { clean?: boolean }) {
    const finished = await session.request({ document: vscode.window.activeTextEditor?.document, manual: true, ...options });
    if (finished?.result.success) {
      const pdf = vscode.Uri.file(finished.project.pdfPath);
      if (!viewer.isOpen(pdf)) await viewer.open(pdf);
    }
    return finished;
  }

  async function syncToPdf() {
    const editor = vscode.window.activeTextEditor;
    if (!editor || !/\.(tex|bbl)$/i.test(editor.document.fileName)) {
      status('go to PDF works from a .tex file');
      return;
    }
    const project = await projects.resolve(editor.document, true);
    if (!project) return;
    const data = loadSyncTex(project.synctexPath, project.mainDir);
    if (!data) {
      status('no SyncTeX data yet: compile the document once');
      return;
    }
    const relative = path.relative(project.mainDir, editor.document.uri.fsPath).split(path.sep).join('/');
    const position = editor.selection.active;
    const result = data.view(relative, position.line + 1);
    if (!result?.boxes.length) {
      status('this line does not appear in the PDF');
      return;
    }
    const wordRange = editor.document.getWordRangeAtPosition(position);
    await viewer.reveal(vscode.Uri.file(project.pdfPath), {
      boxes: result.boxes,
      character: position.character,
      lineLength: editor.document.lineAt(position.line).text.length,
      word: cleanWord(wordRange ? editor.document.getText(wordRange) : ''),
    });
  }

  function columnForSource(document: vscode.TextDocument, pdf: vscode.Uri): vscode.ViewColumn {
    const showing = vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === document.uri.toString());
    if (showing?.viewColumn) return showing.viewColumn;
    const pdfColumn = viewer.viewColumnOf(pdf);
    const other = vscode.window.visibleTextEditors.find((e) => e.viewColumn !== undefined && e.viewColumn !== pdfColumn);
    if (other?.viewColumn) return other.viewColumn;
    return pdfColumn === vscode.ViewColumn.One ? vscode.ViewColumn.Two : vscode.ViewColumn.One;
  }

  async function inverseSearch(uri: vscode.Uri, request: InverseSearchRequest) {
    const project = await projects.forPdf(uri);
    if (!project) {
      status('this PDF is not the output of the current document');
      return;
    }
    const data = loadSyncTex(project.synctexPath, project.mainDir);
    const hit = data?.edit(request.page, request.x, request.y);
    if (!hit) {
      status('no source location found here');
      return;
    }
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(project.mainDir, hit.file)));
    const editor = await vscode.window.showTextDocument(document, { viewColumn: columnForSource(document, uri) });

    const word = findWordNear(document.getText().split(/\r?\n/), hit.line - 1, request.word, request.context);
    const line = Math.max(0, Math.min(word?.line ?? hit.line - 1, document.lineCount - 1));
    const start = new vscode.Position(line, word?.character ?? 0);
    const end = word ? start.translate(0, word.length) : start;
    const range = new vscode.Range(start, end);
    editor.selection = new vscode.Selection(start, end);
    editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);

    editor.setDecorations(lineFlash, [new vscode.Range(line, 0, line, 0)]);
    editor.setDecorations(wordFlash, word ? [range] : []);
    setTimeout(() => {
      editor.setDecorations(lineFlash, []);
      editor.setDecorations(wordFlash, []);
    }, FLASH_MS);
  }

  async function syncToCode() {
    const uri = viewer.activeUri() ?? viewer.anyVisibleUri();
    if (!uri || !viewer.requestInverseSearch(uri)) status('open the PDF first');
  }

  async function pushCitations(uri: vscode.Uri, runCommand: boolean) {
    const project = (await projects.forPdf(uri)) ?? (await projects.resolve(undefined, false));
    if (!project) return;
    const data = await citations.load(project);
    viewer.setCitations(uri, data);
    if (runCommand) void citations.refreshStatus(project);
  }

  async function pushCitationsToAll(runCommand: boolean) {
    for (const uri of viewer.openUris()) await pushCitations(uri, runCommand);
  }

  async function resolveCiteFile(uri: vscode.Uri, request: ResolveCiteFileRequest) {
    const project = (await projects.forPdf(uri)) ?? (await projects.resolve(undefined, false));
    const hit = project ? loadSyncTex(project.synctexPath, project.mainDir)?.edit(request.page, request.x, request.y) : null;
    viewer.sendCiteFileResolved(uri, request.requestId, hit?.file ?? null);
  }

  async function refreshCitationStatus() {
    const project = await projects.resolve(vscode.window.activeTextEditor?.document, true);
    if (!project) return;
    status('refreshing citation status…');
    await citations.refreshStatus(project);
    await pushCitationsToAll(false);
    status('citation status updated');
  }

  async function openPreview() {
    const project = await projects.resolve(vscode.window.activeTextEditor?.document, true);
    if (project) await viewer.open(vscode.Uri.file(project.pdfPath));
  }

  // Automatic builds.
  let autoTimer: NodeJS.Timeout | undefined;
  const scheduleBuild = (document: vscode.TextDocument, delayMs: number) => {
    clearTimeout(autoTimer);
    autoTimer = setTimeout(() => void session.request({ document }), delayMs);
  };
  const trigger = (uri?: vscode.Uri) =>
    vscode.workspace.getConfiguration(CONFIG_SECTION, uri).get<string>('compile.trigger', 'save');

  const isInsideProject = async (document: vscode.TextDocument): Promise<boolean> => {
    const project = await projects.resolve(document, false);
    if (!project) return false;
    const rel = path.relative(project.mainDir, document.uri.fsPath);
    return rel !== '' ? !rel.startsWith('..') && !path.isAbsolute(rel) : true;
  };

  const pushAutoCompileToAll = () => {
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
    for (const uri of viewer.openUris()) {
      viewer.setAutoCompile(uri, trigger(folder ?? uri));
    }
  };

  const toggleAutoCompile = async (uri: vscode.Uri) => {
    const folder = vscode.workspace.getWorkspaceFolder(uri) ?? vscode.workspace.workspaceFolders?.[0];
    const cfg = vscode.workspace.getConfiguration(CONFIG_SECTION, folder?.uri);
    const current = cfg.get<string>('compile.trigger', 'save');
    const next = current === 'off' ? 'save' : 'off';
    const target = folder ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
    await cfg.update('compile.trigger', next, target);
    pushAutoCompileToAll();
    status(next === 'off' ? 'auto-compile on save OFF' : 'auto-compile on save ON');
  };

  context.subscriptions.push(
    session,
    editing,
    researchAssistant,
    citations,
    lineFlash,
    wordFlash,
    vscode.window.registerCustomEditorProvider(VIEW_TYPE, viewer),
    viewer.onInverseSearch(({ uri, request }) => void inverseSearch(uri, request)),
    viewer.onReady((uri) => {
      const folder = vscode.workspace.getWorkspaceFolder(uri) ?? vscode.workspace.workspaceFolders?.[0];
      viewer.setAutoCompile(uri, trigger(folder?.uri ?? uri));
      void pushCitations(uri, true);
    }),
    viewer.onToggleAutoCompile((uri) => void toggleAutoCompile(uri)),
    viewer.onShowLog(() => {
      session.showLog();
      void vscode.commands.executeCommand('workbench.actions.view.problems');
    }),
    viewer.onResolveCiteFile(({ uri, request }) => void resolveCiteFile(uri, request)),
    citations.onDidChange(() => void pushCitationsToAll(false)),
    researchAssistant.onDidSyncZotero(() => void pushCitationsToAll(true)),
    session.onDidFinish((finished) => {
      if (finished.result.success) void pushCitationsToAll(true);
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration(`${CONFIG_SECTION}.citations`) || event.affectsConfiguration(`${CONFIG_SECTION}.researchAssistant`)) {
        void pushCitationsToAll(true);
      }
      if (event.affectsConfiguration(`${CONFIG_SECTION}.compile.trigger`)) {
        pushAutoCompileToAll();
      }
    }),
    vscode.commands.registerCommand('openScriptorium.compile', () => compile({})),
    vscode.commands.registerCommand('openScriptorium.compileClean', () => compile({ clean: true })),
    vscode.commands.registerCommand('openScriptorium.openPreview', openPreview),
    vscode.commands.registerCommand('openScriptorium.syncToPdf', syncToPdf),
    vscode.commands.registerCommand('openScriptorium.syncToCode', syncToCode),
    vscode.commands.registerCommand('openScriptorium.showLog', () => session.showLog()),
    vscode.commands.registerCommand('openScriptorium.refreshCitationStatus', refreshCitationStatus),
    vscode.commands.registerCommand('openScriptorium.researchAssistant.setup', () => researchAssistant.setupWizard()),
    vscode.commands.registerCommand('openScriptorium.researchAssistant.status', () => researchAssistant.showStatus()),
    vscode.commands.registerCommand('openScriptorium.researchAssistant.syncZotero', () => researchAssistant.syncZotero(false)),
    vscode.commands.registerCommand('openScriptorium.researchAssistant.openWebUi', () => researchAssistant.openWebUi()),
    vscode.commands.registerCommand('openScriptorium.researchAssistant.registerClients', () => researchAssistant.registerClientsInteractive()),
    vscode.commands.registerCommand('openScriptorium.researchAssistant.installWorkspaceSkill', () => researchAssistant.installWorkspaceSkill()),
    vscode.workspace.onDidSaveTextDocument((document) => {
      if (session.savingForBuild || !LATEX_FILE.test(document.fileName) || trigger(document.uri) !== 'save') return;
      void isInsideProject(document).then((inside) => {
        if (inside) scheduleBuild(document, SAVE_DEBOUNCE_MS);
      });
    }),
    vscode.workspace.onDidChangeTextDocument(({ document, contentChanges }) => {
      if (!contentChanges.length || !LATEX_FILE.test(document.fileName) || trigger(document.uri) !== 'typing') return;
      const delay = vscode.workspace.getConfiguration(CONFIG_SECTION, document.uri).get<number>('compile.typingDelayMs', 2800);
      void isInsideProject(document).then((inside) => {
        if (inside) scheduleBuild(document, delay);
      });
    }),
    { dispose: () => clearTimeout(autoTimer) },
  );

  return { session, viewer, projects, editing, inverseSearch };
}

export function deactivate(): void {}

// Runs inside a real editor window via --extensionTestsPath.
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { ExtensionApi } from '../../src/extension';

interface Run {
  reportPath: string;
  mode: 'fixture' | 'thesis';
}

const EXTENSION_ID = 'open-scriptorium.open-scriptorium';

async function waitFor<T>(what: string, probe: () => T | undefined | null | false, timeoutMs = 20000): Promise<T> {
  const started = Date.now();
  for (;;) {
    const value = probe();
    if (value) return value;
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function positionOf(document: vscode.TextDocument, text: string): vscode.Position {
  const offset = document.getText().indexOf(text);
  assert.ok(offset >= 0, `"${text}" not found in ${document.fileName}`);
  return document.positionAt(offset);
}

async function openAt(uri: vscode.Uri, text: string): Promise<vscode.TextEditor> {
  const document = await vscode.workspace.openTextDocument(uri);
  const editor = await vscode.window.showTextDocument(document, vscode.ViewColumn.One);
  const position = positionOf(document, text);
  editor.selection = new vscode.Selection(position, position);
  return editor;
}

async function appendLine(editor: vscode.TextEditor, text: string): Promise<number> {
  const document = editor.document;
  const last = document.lineCount - 1;
  await editor.edit((b) => b.insert(document.lineAt(last).range.end, `\n${text}\n`));
  return last + 1;
}

async function setText(document: vscode.TextDocument, text: string): Promise<void> {
  const edit = new vscode.WorkspaceEdit();
  edit.replace(document.uri, new vscode.Range(0, 0, document.lineCount, 0), text);
  await vscode.workspace.applyEdit(edit);
}

export async function run(): Promise<void> {
  const config: Run = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', '.e2e-run.json'), 'utf8'));
  const report: Record<string, unknown> = { appName: vscode.env.appName, version: vscode.version, mode: config.mode, steps: [] };
  const step = async (name: string, body: () => Promise<unknown>) => {
    const started = Date.now();
    try {
      const detail = await body();
      (report.steps as unknown[]).push({ name, ok: true, ms: Date.now() - started, detail });
    } catch (error) {
      (report.steps as unknown[]).push({ name, ok: false, ms: Date.now() - started, error: String((error as Error).stack ?? error) });
      throw error;
    }
  };

  try {
    const extension = vscode.extensions.getExtension<ExtensionApi>(EXTENSION_ID);
    assert.ok(extension, 'extension not found');
    const api = await extension.activate();
    const root = vscode.workspace.workspaceFolders![0].uri.fsPath;
    if (config.mode === 'fixture') await fixture(api, root, step);
    else await thesis(api, root, step);
    report.passed = true;
  } catch (error) {
    report.passed = false;
    throw error;
  } finally {
    fs.mkdirSync(path.dirname(config.reportPath), { recursive: true });
    fs.writeFileSync(config.reportPath, JSON.stringify(report, null, 2));
  }
}

type Step = (name: string, body: () => Promise<unknown>) => Promise<void>;

async function fixture(api: ExtensionApi, root: string, step: Step): Promise<void> {
  const ch1 = vscode.Uri.file(path.join(root, 'ch1.tex'));
  const main = vscode.Uri.file(path.join(root, 'main.tex'));
  const pdf = vscode.Uri.file(path.join(root, '.scriptorium', 'build', 'main.pdf'));
  const synctex = path.join(root, '.scriptorium', 'build', 'main.synctex.gz');
  await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(ch1));

  await step('finds the main file from a chapter', async () => {
    const project = await api.projects.resolve(vscode.window.activeTextEditor!.document, false);
    assert.equal(path.basename(project!.mainFile), 'main.tex');
  });

  await step('compile produces PDF, SyncTeX and opens the viewer', async () => {
    const finished: any = await vscode.commands.executeCommand('openScriptorium.compile');
    assert.equal(finished.result.success, true, finished.result.log);
    assert.ok(fs.existsSync(pdf.fsPath));
    assert.ok(fs.existsSync(synctex));
    assert.ok(fs.existsSync(path.join(root, '.scriptorium', '.gitignore')));
    const info = await waitFor('viewer load', () => (api.viewer.info(pdf)?.loads ? api.viewer.info(pdf) : null));
    assert.ok(info.numPages >= 1);
    return { durationMs: finished.result.durationMs, numPages: info.numPages };
  });

  await step('goes from source to PDF', async () => {
    await openAt(ch1, 'zanzibarword');
    await vscode.commands.executeCommand('openScriptorium.syncToPdf');
    const page = await waitFor('reveal', () => api.viewer.info(pdf)?.lastRevealedPage);
    assert.equal(page, 1);
    return { page };
  });

  await step('goes from PDF to the exact word in the source', async () => {
    const editorBefore = await openAt(main, 'documentclass');
    assert.ok(editorBefore);
    const { loadSyncTex } = await import('../../src/synctex');
    const data = loadSyncTex(synctex, root)!;
    const view = data.view('ch1.tex', 4)!;
    const box = view.boxes[0];
    await api.inverseSearch(pdf, {
      page: box.page,
      x: box.x + box.width / 2,
      y: box.y + box.height / 2,
      word: 'zanzibarword',
      context: 'then the zanzibarword marker',
    });
    const editor = vscode.window.activeTextEditor!;
    assert.equal(path.basename(editor.document.fileName), 'ch1.tex');
    assert.equal(editor.document.getText(editor.selection), 'zanzibarword');
    return { line: editor.selection.active.line + 1 };
  });

  await step('a TeX error appears on the right line and keeps the old PDF', async () => {
    const before = api.viewer.info(pdf)!.loads;
    const editor = await openAt(ch1, 'First chapter');
    const original = editor.document.getText();
    const line = await appendLine(editor, '\\undefinedmacroxyz');
    const finished: any = await vscode.commands.executeCommand('openScriptorium.compile');
    assert.equal(finished.result.success, false);
    assert.equal(editor.document.isDirty, false, 'compile should save project files');
    const errors = api.session.getDiagnostics(ch1).filter((d) => d.severity === vscode.DiagnosticSeverity.Error);
    assert.ok(errors.length >= 1, JSON.stringify(finished.result.issues));
    assert.ok(errors.some((d) => d.range.start.line === line), JSON.stringify(errors.map((d) => [d.range.start.line, d.message])));
    assert.equal(api.viewer.info(pdf)!.loads, before);

    await setText(editor.document, original);
    await editor.document.save();
    const fixed: any = await vscode.commands.executeCommand('openScriptorium.compile');
    assert.equal(fixed.result.success, true, fixed.result.log);
    assert.equal(api.session.getDiagnostics(ch1).filter((d) => d.severity === vscode.DiagnosticSeverity.Error).length, 0);
    await waitFor('reload after fix', () => api.viewer.info(pdf)!.loads > before);
    return { errors: errors.map((d) => d.message) };
  });

  await step('saving triggers a build when configured', async () => {
    const config = vscode.workspace.getConfiguration('openScriptorium');
    await config.update('compile.trigger', 'save', vscode.ConfigurationTarget.Workspace);
    const runs = api.session.runs;
    const loads = api.viewer.info(pdf)!.loads;
    const editor = await openAt(ch1, 'First chapter');
    const original = editor.document.getText();
    await editor.edit((b) => b.insert(new vscode.Position(0, 0), '% edited\n'));
    await editor.document.save();
    await waitFor('build after save', () => api.session.runs > runs);
    await waitFor('reload after save', () => api.viewer.info(pdf)!.loads > loads, 40000);
    await config.update('compile.trigger', 'off', vscode.ConfigurationTarget.Workspace);
    await setText(editor.document, original);
    await editor.document.save();
    return { runsAdded: api.session.runs - runs };
  });

  await step('requests during a build merge into one follow-up', async () => {
    const runs = api.session.runs;
    const results: any[] = await Promise.all([
      api.session.request({ manual: false }),
      api.session.request({ manual: false }),
      api.session.request({ manual: false }),
      api.session.request({ manual: false }),
    ]);
    assert.equal(api.session.runs - runs, 2);
    assert.ok(results.every((r) => r?.result.success));
  });

  await step('clean build succeeds from the command', async () => {
    const finished: any = await vscode.commands.executeCommand('openScriptorium.compileClean');
    assert.equal(finished.result.success, true);
    assert.ok(fs.existsSync(pdf.fsPath));
  });

  await step('a PDF changed on disk reloads the viewer', async () => {
    // Let the previous build's reload land first, or it would be mistaken for this one.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const loads = api.viewer.info(pdf)!.loads;
    const bytes = fs.readFileSync(pdf.fsPath);
    const started = Date.now();
    fs.writeFileSync(pdf.fsPath, bytes);
    await waitFor('reload from disk', () => api.viewer.info(pdf)!.loads > loads);
    const latencyMs = Date.now() - started;
    assert.ok(latencyMs >= 150, `reloaded after ${latencyMs}ms, faster than the watcher debounce allows`);
    return { latencyMs };
  });

  await step('an unchanged PDF is not reloaded', async () => {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const loads = api.viewer.info(pdf)!.loads;
    await api.viewer.refresh(pdf);
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(api.viewer.info(pdf)!.loads, loads);
  });

  const labelText = (item: vscode.CompletionItem) => (typeof item.label === 'string' ? item.label : item.label.label);

  await step('completes citations, labels and environments', async () => {
    const editor = await openAt(ch1, 'Closing paragraph');
    const original = editor.document.getText();
    const completeAfter = async (text: string) => {
      await setText(editor.document, `${original}\n${text}`);
      const position = editor.document.lineAt(editor.document.lineCount - 1).range.end;
      const list = await vscode.commands.executeCommand<vscode.CompletionList>('vscode.executeCompletionItemProvider', ch1, position);
      return list.items;
    };
    const citation = (await completeAfter('\\cite{do')).find((i) => labelText(i) === 'doe2020avatars');
    assert.ok(citation, 'citation key missing');
    const reference = (await completeAfter('\\ref{sec')).find((i) => labelText(i) === 'sec:intro');
    assert.ok(reference, 'label missing');
    const environment = (await completeAfter('\\begin{ite')).find((i) => labelText(i) === 'itemize');
    assert.ok(environment, 'environment missing');
    await setText(editor.document, original);
    await editor.document.save();
    return { citationDescription: typeof citation.label === 'string' ? null : citation.label.description };
  });

  await step('outlines the document', async () => {
    const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>('vscode.executeDocumentSymbolProvider', main);
    assert.deepEqual(symbols.map((s) => s.name), ['Introduction']);
  });

  await step('insert commands wrap the selection and add blocks', async () => {
    const editor = await openAt(ch1, 'Closing paragraph');
    const original = editor.document.getText();
    const start = positionOf(editor.document, 'Closing');
    editor.selection = new vscode.Selection(start, start.translate(0, 'Closing'.length));
    await vscode.commands.executeCommand('openScriptorium.insert.bold');
    assert.ok(editor.document.getText().includes('\\textbf{Closing} paragraph'), editor.document.getText());
    await setText(editor.document, original);

    const math = positionOf(editor.document, 'Closing');
    editor.selection = new vscode.Selection(math, math.translate(0, 'Closing'.length));
    await vscode.commands.executeCommand('openScriptorium.insert.math');
    assert.ok(editor.document.getText().includes('$Closing$ paragraph'), editor.document.getText());
    await setText(editor.document, original);

    const end = editor.document.lineAt(editor.document.lineCount - 1).range.end;
    editor.selection = new vscode.Selection(end, end);
    await vscode.commands.executeCommand('openScriptorium.insert.figure');
    const text = editor.document.getText();
    assert.ok(text.includes('\\begin{figure}[htbp]') && text.includes('\\includegraphics[width=0.85\\textwidth]{figures/sample.png}'), text);
    await setText(editor.document, original);
    await editor.document.save();
  });

  await step('counts words for the file and the document', async () => {
    const editor = await openAt(ch1, 'Closing paragraph');
    const report = (await api.editing.wordReport(editor.document))!;
    assert.deepEqual(report.files.map((f) => f.relative), ['main.tex', 'ch1.tex']);
    assert.ok(report.total.words > 20);
    assert.equal(report.total.headings, 1);
    const status = await waitFor('word count in the status bar', () => (api.editing.statusText.includes('words') ? api.editing.statusText : null));
    return { total: report.total.words, status };
  });
}

async function thesis(api: ExtensionApi, root: string, step: Step): Promise<void> {
  const chapter = vscode.Uri.file(path.join(root, 'chapters', '01_introduction', '01_introduction.tex'));
  const pdf = vscode.Uri.file(path.join(root, '.scriptorium', 'build', 'main.pdf'));
  await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(chapter));

  await step('compiles the full thesis', async () => {
    const finished: any = await vscode.commands.executeCommand('openScriptorium.compile');
    assert.equal(finished.result.success, true, finished.result.log.slice(-2000));
    const info = await waitFor('viewer load', () => (api.viewer.info(pdf)?.loads ? api.viewer.info(pdf) : null));
    const diagnostics = vscode.languages.getDiagnostics().flatMap(([uri, items]) => items.map((d) => path.basename(uri.fsPath)));
    return {
      durationMs: finished.result.durationMs,
      numPages: info.numPages,
      parsedIssues: finished.result.issues.length,
      problemsPanelEntries: diagnostics.length,
      packageFilesInProblems: diagnostics.filter((f) => f.endsWith('.sty') || f.endsWith('.def')).length,
    };
  });

  await step('source to PDF in a chapter', async () => {
    await openAt(chapter, 'Believability does not reside');
    await vscode.commands.executeCommand('openScriptorium.syncToPdf');
    return { page: await waitFor('reveal', () => api.viewer.info(pdf)?.lastRevealedPage) };
  });

  await step('PDF to the exact word in a chapter', async () => {
    const { loadSyncTex } = await import('../../src/synctex');
    const data = loadSyncTex(path.join(root, '.scriptorium', 'build', 'main.synctex.gz'), root)!;
    const document = await vscode.workspace.openTextDocument(chapter);
    const line = positionOf(document, 'Believability does not reside').line + 1;
    const box = data.view('chapters/01_introduction/01_introduction.tex', line)!.boxes[0];
    await api.inverseSearch(pdf, { page: box.page, x: box.x + 5, y: box.y + box.height / 2, word: 'Believability', context: 'Believability does not reside solely' });
    const editor = vscode.window.activeTextEditor!;
    assert.equal(path.basename(editor.document.fileName), '01_introduction.tex');
    assert.equal(editor.document.getText(editor.selection), 'Believability');
    return { line: editor.selection.active.line + 1, page: box.page };
  });
}

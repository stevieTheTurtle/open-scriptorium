// One compile at a time. Requests made during a build merge into a single follow-up build.

import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import * as path from 'node:path';
import { findOnPath, runTectonic, type CompileResult } from './compile.ts';
import type { Issue } from './issues.ts';
import { CONFIG_SECTION, ignoreDefaultOutDir, type Project, type ProjectResolver } from './project.ts';
import type { PdfViewer } from './viewer.ts';

const TECTONIC_INSTALL_URL = 'https://tectonic-typesetting.github.io/book/latest/installation/';

export interface CompileOptions {
  document?: vscode.TextDocument;
  clean?: boolean;
  /** The user asked for this build: prompts are allowed and failures are shown. */
  manual?: boolean;
}

export interface FinishedCompile {
  project: Project;
  result: CompileResult;
  manual: boolean;
}

interface Pending {
  options: CompileOptions;
  promise: Promise<FinishedCompile | undefined>;
  resolve: (value: FinishedCompile | undefined | PromiseLike<FinishedCompile | undefined>) => void;
}

/** The compiler names files as written in \input, so "ch1" can mean ch1.tex. */
function sourceFile(mainDir: string, name: string): string | null {
  const file = path.resolve(mainDir, name);
  for (const candidate of [file, `${file}.tex`]) {
    if (statSync(candidate, { throwIfNoEntry: false })?.isFile()) return candidate;
  }
  return null;
}

export class CompileSession implements vscode.Disposable {
  /** Number of builds actually started. */
  runs = 0;
  /** True while dirty files are being saved for a build, so those saves do not trigger another one. */
  savingForBuild = false;

  private readonly finished = new vscode.EventEmitter<FinishedCompile>();
  readonly onDidFinish = this.finished.event;

  private readonly output = vscode.window.createOutputChannel('Open Scriptorium');
  private readonly diagnostics = vscode.languages.createDiagnosticCollection('openScriptorium');
  private readonly status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  private readonly abort = new AbortController();

  private readonly projects: ProjectResolver;
  private readonly viewer: PdfViewer;
  private current: Promise<FinishedCompile | undefined> | undefined;
  private pending: Pending | undefined;

  constructor(projects: ProjectResolver, viewer: PdfViewer) {
    this.projects = projects;
    this.viewer = viewer;
    this.status.command = 'openScriptorium.compile';
    this.status.text = '$(play) LaTeX';
    this.status.tooltip = 'Compile the document';
    this.status.show();
  }

  dispose(): void {
    this.abort.abort();
    this.finished.dispose();
    this.output.dispose();
    this.diagnostics.dispose();
    this.status.dispose();
  }

  showLog(): void {
    this.output.show(true);
  }

  getDiagnostics(uri: vscode.Uri): readonly vscode.Diagnostic[] {
    return this.diagnostics.get(uri) ?? [];
  }

  request(options: CompileOptions): Promise<FinishedCompile | undefined> {
    if (!this.current) return this.start(options);
    if (this.pending) {
      this.pending.options = {
        document: options.document ?? this.pending.options.document,
        clean: this.pending.options.clean || options.clean,
        manual: this.pending.options.manual || options.manual,
      };
      return this.pending.promise;
    }
    let resolve!: Pending['resolve'];
    const promise = new Promise<FinishedCompile | undefined>((r) => (resolve = r));
    this.pending = { options, promise, resolve };
    return promise;
  }

  private start(options: CompileOptions): Promise<FinishedCompile | undefined> {
    const run = this.build(options).finally(() => {
      this.current = undefined;
      const next = this.pending;
      this.pending = undefined;
      if (next) next.resolve(this.start(next.options));
    });
    this.current = run;
    return run;
  }

  private async build(options: CompileOptions): Promise<FinishedCompile | undefined> {
    const manual = options.manual ?? false;
    if (!vscode.workspace.isTrusted) {
      if (manual) void vscode.window.showWarningMessage('Open Scriptorium only compiles in trusted workspaces.');
      return undefined;
    }
    const project = await this.projects.resolve(options.document, manual);
    if (!project) {
      if (manual) void vscode.window.showWarningMessage('Open Scriptorium: no main LaTeX file found. Set "openScriptorium.mainFile".');
      return undefined;
    }
    const executable = this.findTectonic(project);
    if (!executable) {
      this.status.text = '$(error) LaTeX: Tectonic not found';
      if (manual) void this.reportMissingTectonic();
      return undefined;
    }

    await this.saveProjectFiles(project);
    await this.projects.remember(project);
    ignoreDefaultOutDir(project);

    this.runs++;
    this.output.clear();
    this.status.text = '$(sync~spin) LaTeX: compiling';
    const pdfTargets = this.targetPdfUris(project);
    for (const uri of pdfTargets) {
      this.viewer.setBusy(uri, true);
      this.viewer.setCompileStatus(uri, { state: 'compiling' });
    }

    let result: CompileResult;
    try {
      result = await runTectonic({
        executable,
        mainFile: project.mainFile,
        outDir: project.outDir,
        pdfPath: project.pdfPath,
        synctexPath: project.synctexPath,
        clean: options.clean,
        onOutput: (text) => this.output.append(text),
        signal: this.abort.signal,
      });
      if (result.success) await this.copyPdf(project);
    } finally {
      for (const uri of pdfTargets) this.viewer.setBusy(uri, false);
    }

    const counts = this.publishDiagnostics(project, result.issues);
    this.showOutcome(result, counts);
    const localWarnings = counts.warnings - Math.min(counts.fromPackages, counts.warnings);
    for (const uri of pdfTargets) {
      this.viewer.setCompileStatus(
        uri,
        result.success
          ? { state: 'success', durationMs: result.durationMs, warnings: localWarnings }
          : { state: 'error', errors: counts.errors, message: result.error },
      );
      if (result.success) await this.viewer.refresh(uri);
    }
    if (manual && !result.success) {
      await vscode.commands.executeCommand('workbench.actions.view.problems');
      if (result.error) void vscode.window.showErrorMessage(`Open Scriptorium: could not run Tectonic: ${result.error}`);
    }

    const finished = { project, result, manual };
    this.finished.fire(finished);
    return finished;
  }

  /** Both the primary built PDF and any `copyPdfTo` mirror, so either open tab gets status & reload events. */
  private targetPdfUris(project: Project): vscode.Uri[] {
    const uris = [vscode.Uri.file(project.pdfPath)];
    const setting = vscode.workspace.getConfiguration(CONFIG_SECTION, project.folder?.uri).get<string>('copyPdfTo', '');
    if (setting) {
      const target = path.isAbsolute(setting) ? setting : path.join(project.folder?.uri.fsPath ?? project.mainDir, setting);
      if (path.relative(project.pdfPath, target) !== '') {
        uris.push(vscode.Uri.file(target));
      }
    }
    return uris;
  }

  private findTectonic(project: Project): string | null {
    const config = vscode.workspace.getConfiguration(CONFIG_SECTION, project.folder?.uri);
    const setting = config.get<string>('tectonicPath', '');
    if (setting) {
      const resolved = path.isAbsolute(setting) ? setting : path.join(project.folder?.uri.fsPath ?? project.mainDir, setting);
      return existsSync(resolved) ? resolved : null;
    }
    return findOnPath('tectonic');
  }

  private async reportMissingTectonic(): Promise<void> {
    const openSettings = 'Open Settings';
    const install = 'How to Install';
    const choice = await vscode.window.showErrorMessage(
      'Open Scriptorium could not find Tectonic. Install it, or set "openScriptorium.tectonicPath".',
      install,
      openSettings,
    );
    if (choice === install) void vscode.env.openExternal(vscode.Uri.parse(TECTONIC_INSTALL_URL));
    if (choice === openSettings) void vscode.commands.executeCommand('workbench.action.openSettings', `${CONFIG_SECTION}.tectonicPath`);
  }

  private async saveProjectFiles(project: Project): Promise<void> {
    const inside = (file: string) => {
      const relative = path.relative(project.mainDir, file);
      return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
    };
    const dirty = vscode.workspace.textDocuments.filter((d) => d.isDirty && d.uri.scheme === 'file' && inside(d.uri.fsPath));
    if (!dirty.length) return;
    this.savingForBuild = true;
    try {
      await Promise.all(dirty.map((d) => d.save()));
    } finally {
      this.savingForBuild = false;
    }
  }

  private async copyPdf(project: Project): Promise<void> {
    const setting = vscode.workspace.getConfiguration(CONFIG_SECTION, project.folder?.uri).get<string>('copyPdfTo', '');
    if (!setting) return;
    const target = path.isAbsolute(setting) ? setting : path.join(project.folder?.uri.fsPath ?? project.mainDir, setting);
    try {
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.copyFile(project.pdfPath, target);
    } catch (error) {
      this.output.appendLine(`\nCould not copy the PDF to ${target}: ${error}`);
    }
  }

  private publishDiagnostics(project: Project, issues: Issue[]) {
    const byFile = new Map<string, vscode.Diagnostic[]>();
    const seen = new Set<string>();
    const counts = { errors: 0, warnings: 0, badBoxes: 0, fromPackages: 0 };
    const add = (file: string, diagnostic: vscode.Diagnostic) => {
      if (!byFile.has(file)) byFile.set(file, []);
      byFile.get(file)!.push(diagnostic);
    };

    for (const issue of issues) {
      const key = `${issue.type}|${issue.file}|${issue.line}|${issue.message}`;
      if (seen.has(key)) continue;
      seen.add(key);

      if (issue.type === 'error') counts.errors++;
      else if (issue.type === 'warning') counts.warnings++;
      else counts.badBoxes++;

      const file = sourceFile(project.mainDir, issue.file);
      const located = file !== null;
      if (!located && issue.type !== 'error') {
        // Warnings inside packages cannot be acted on, and the file is not on disk anyway.
        counts.fromPackages++;
        continue;
      }

      const line = located ? Math.max(0, issue.line - 1) : 0;
      const message = located ? issue.message : `${issue.file}:${issue.line}: ${issue.message}`;
      const severity =
        issue.type === 'error'
          ? vscode.DiagnosticSeverity.Error
          : issue.type === 'warning'
            ? vscode.DiagnosticSeverity.Warning
            : vscode.DiagnosticSeverity.Information;
      const diagnostic = new vscode.Diagnostic(new vscode.Range(line, 0, line, 65535), message || issue.type, severity);
      diagnostic.source = 'Tectonic';
      if (issue.type === 'badbox') diagnostic.code = 'bad box';
      add(file ?? project.mainFile, diagnostic);
    }

    this.diagnostics.clear();
    for (const [file, diagnostics] of byFile) this.diagnostics.set(vscode.Uri.file(file), diagnostics);
    return counts;
  }

  private showOutcome(result: CompileResult, counts: { errors: number; warnings: number; badBoxes: number; fromPackages: number }): void {
    const seconds = (result.durationMs / 1000).toFixed(1);
    if (result.success) {
      const total = counts.warnings - Math.min(counts.fromPackages, counts.warnings);
      this.status.text = total ? `$(warning) LaTeX ${seconds}s` : `$(check) LaTeX ${seconds}s`;
      this.status.tooltip = `Compiled in ${seconds}s. ${total} warnings, ${counts.badBoxes} bad boxes, ${counts.fromPackages} from packages (see the log). Click to recompile.`;
    } else {
      const label = counts.errors === 1 ? '1 error' : `${counts.errors} errors`;
      this.status.text = `$(error) LaTeX: ${counts.errors ? label : 'failed'}`;
      this.status.tooltip = 'Compilation failed: see the Problems panel or the log. Click to recompile.';
    }
  }
}

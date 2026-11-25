// One compile at a time. Requests made during a build merge into a single follow-up build.

import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import * as path from 'node:path';
import { findOnPath, runTectonic, type CompileResult } from './compile.ts';
import type { Issue } from './issues.ts';
import { CONFIG_SECTION, ignoreDefaultOutDir, type Project, type ProjectResolver } from './project.ts';
import { installTectonic, managedTectonicPath, type InstallTectonicResult } from './tectonicInstaller.ts';
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
  private installing: Promise<InstallTectonicResult | null> | undefined;
  private autoInstallFailed = false;

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
    const { executable, configuredMissing } = await this.resolveOrInstallTectonic(project, manual);
    if (!executable) {
      this.status.text = '$(error) LaTeX: Tectonic not found';
      if (manual) void this.reportMissingTectonic(configuredMissing);
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

  private findTectonic(project: Project): { executable: string | null; configuredMissing: boolean } {
    const config = vscode.workspace.getConfiguration(CONFIG_SECTION, project.folder?.uri);
    const setting = config.get<string>('tectonicPath', '').trim();
    if (setting) {
      const resolved = path.isAbsolute(setting) ? setting : path.join(project.folder?.uri.fsPath ?? project.mainDir, setting);
      return existsSync(resolved) ? { executable: resolved, configuredMissing: false } : { executable: null, configuredMissing: true };
    }
    const onPath = findOnPath('tectonic');
    if (onPath) return { executable: onPath, configuredMissing: false };
    const managed = managedTectonicPath();
    if (existsSync(managed)) return { executable: managed, configuredMissing: false };
    return { executable: null, configuredMissing: false };
  }

  private async resolveOrInstallTectonic(
    project: Project,
    manual: boolean,
  ): Promise<{ executable: string | null; configuredMissing: boolean }> {
    const found = this.findTectonic(project);
    if (found.executable || found.configuredMissing) return found;

    const autoInstall = vscode.workspace
      .getConfiguration(CONFIG_SECTION, project.folder?.uri)
      .get<boolean>('tectonic.autoInstall', true);
    if (!autoInstall || (!manual && this.autoInstallFailed)) {
      return found;
    }

    const installed = await this.installManagedTectonic(false);
    if (installed) {
      this.autoInstallFailed = false;
      return { executable: installed.executable, configuredMissing: false };
    }
    this.autoInstallFailed = true;
    return { executable: null, configuredMissing: false };
  }

  /** Downloads and installs the managed Tectonic binary into ~/.open-scriptorium/bin/. */
  installManagedTectonic(showErrors = true): Promise<InstallTectonicResult | null> {
    if (this.installing) return this.installing;
    const run = this.performTectonicInstall(showErrors).finally(() => {
      this.installing = undefined;
    });
    this.installing = run;
    return run;
  }

  async installTectonicCommand(): Promise<void> {
    if (!vscode.workspace.isTrusted) {
      void vscode.window.showWarningMessage('Open Scriptorium only installs tools in trusted workspaces.');
      return;
    }
    const result = await this.installManagedTectonic(true);
    if (!result) return;
    this.autoInstallFailed = false;
    const configured = vscode.workspace.getConfiguration(CONFIG_SECTION).get<string>('tectonicPath', '').trim();
    if (configured) {
      const openSettings = 'Open Settings';
      const choice = await vscode.window.showInformationMessage(
        `Open Scriptorium installed ${result.version} to ${result.executable}. Note: "openScriptorium.tectonicPath" is currently set and takes precedence.`,
        openSettings,
      );
      if (choice === openSettings) {
        void vscode.commands.executeCommand('workbench.action.openSettings', `${CONFIG_SECTION}.tectonicPath`);
      }
    } else {
      void vscode.window.showInformationMessage(`Open Scriptorium installed ${result.version} to ${result.executable}.`);
    }
  }

  private async performTectonicInstall(showErrors: boolean): Promise<InstallTectonicResult | null> {
    this.status.text = '$(cloud-download) LaTeX: installing Tectonic';
    this.status.tooltip = 'Downloading and installing Tectonic...';
    this.output.appendLine('Installing managed Tectonic binary...');

    let cancelled = false;
    try {
      const result = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Open Scriptorium: Installing Tectonic',
          cancellable: true,
        },
        async (progress, token) => {
          const controller = new AbortController();
          const onSessionAbort = () => controller.abort();
          this.abort.signal.addEventListener('abort', onSessionAbort, { once: true });
          const cancelSub = token.onCancellationRequested(() => {
            cancelled = true;
            controller.abort();
          });

          let lastPercent = 0;
          try {
            return await installTectonic({
              signal: controller.signal,
              onProgress: (p) => {
                if (p.phase === 'downloading' && p.totalBytes && p.receivedBytes !== undefined) {
                  const pct = Math.min(100, Math.floor((p.receivedBytes / p.totalBytes) * 100));
                  const increment = Math.max(0, pct - lastPercent);
                  lastPercent = pct;
                  const mbDone = (p.receivedBytes / 1_048_576).toFixed(1);
                  const mbTotal = (p.totalBytes / 1_048_576).toFixed(1);
                  progress.report({ message: `${p.message} (${mbDone} / ${mbTotal} MB)`, increment });
                } else {
                  progress.report({ message: p.message });
                }
              },
            });
          } finally {
            cancelSub.dispose();
            this.abort.signal.removeEventListener('abort', onSessionAbort);
          }
        },
      );
      this.output.appendLine(`Installed ${result.version} (${result.tag}) to ${result.executable}.`);
      this.status.text = '$(check) LaTeX';
      this.status.tooltip = `Tectonic ready (${result.version}). Click to compile.`;
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.output.appendLine(cancelled ? 'Tectonic installation cancelled.' : `Tectonic installation failed: ${message}`);
      this.status.text = '$(error) LaTeX: Tectonic not found';
      if (showErrors && !cancelled) {
        const install = 'How to Install';
        const openSettings = 'Open Settings';
        const choice = await vscode.window.showErrorMessage(
          `Open Scriptorium could not install Tectonic automatically: ${message}`,
          install,
          openSettings,
        );
        if (choice === install) void vscode.env.openExternal(vscode.Uri.parse(TECTONIC_INSTALL_URL));
        if (choice === openSettings) {
          void vscode.commands.executeCommand('workbench.action.openSettings', `${CONFIG_SECTION}.tectonicPath`);
        }
      }
      return null;
    }
  }

  private async reportMissingTectonic(configuredMissing: boolean): Promise<void> {
    const installAuto = 'Install Automatically';
    const openSettings = 'Open Settings';
    const installDocs = 'How to Install';
    const message = configuredMissing
      ? 'Open Scriptorium could not find Tectonic at the path set in "openScriptorium.tectonicPath".'
      : 'Open Scriptorium could not find Tectonic. Install it automatically, install it manually, or set "openScriptorium.tectonicPath".';
    const buttons = configuredMissing ? [openSettings, installDocs] : [installAuto, installDocs, openSettings];
    const choice = await vscode.window.showErrorMessage(message, ...buttons);
    if (choice === installAuto) {
      const installed = await this.installManagedTectonic(true);
      if (installed) {
        this.autoInstallFailed = false;
        void this.request({ manual: true });
      }
    }
    if (choice === installDocs) void vscode.env.openExternal(vscode.Uri.parse(TECTONIC_INSTALL_URL));
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

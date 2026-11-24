// Loads citation metadata, evidence notes, and external citation status for a project,
// watches those files for live updates, and optionally runs a status refresh command.

import * as vscode from 'vscode';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { parseBib, type BibFields } from './bib.ts';
import { mergeCitations, parseNotesFile, parseStatusFile, type CitationEntry, type CitationNote, type CitationStatus } from './citations.ts';
import { CONFIG_SECTION, type Project } from './project.ts';
import type { ResearchAssistantService } from './researchAssistant.ts';

const EXCLUDED = '**/{node_modules,.git,_Old,.latex-studio}/**';
const WATCH_DEBOUNCE_MS = 200;

function resolveWorkspacePath(setting: string, project: Project): string | null {
  const trimmed = setting.trim();
  if (!trimmed) return null;
  return path.isAbsolute(trimmed) ? trimmed : path.join(project.folder?.uri.fsPath ?? project.mainDir, trimmed);
}

async function readIfExists(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, 'utf8');
  } catch {
    return null;
  }
}

export class CitationService implements vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;

  private readonly researchAssistant: ResearchAssistantService | undefined;
  private watchers: vscode.Disposable[] = [];
  private watchedKey = '';
  private debounce: NodeJS.Timeout | undefined;
  private runningCommand: Promise<void> | undefined;
  private pendingRefresh = false;

  constructor(researchAssistant?: ResearchAssistantService) {
    this.researchAssistant = researchAssistant;
  }

  dispose(): void {
    clearTimeout(this.debounce);
    this.clearWatchers();
    this.changed.dispose();
  }

  /** Collects .bib entries, evidence notes, and citation status for a project. */
  async load(project: Project): Promise<Record<string, CitationEntry>> {
    const config = vscode.workspace.getConfiguration(CONFIG_SECTION, project.folder?.uri);
    const notesSetting = config.get<string>('citations.notesFile', '');
    const statusSetting = config.get<string>('citations.statusFile', '');

    const notesPath = resolveWorkspacePath(notesSetting, project);
    const statusPath = resolveWorkspacePath(statusSetting, project) ?? path.join(project.outDir, 'citation_status.json');
    this.ensureWatchers(project, notesPath, statusPath);

    const bibUris = await vscode.workspace.findFiles(new vscode.RelativePattern(vscode.Uri.file(project.mainDir), '**/*.bib'), EXCLUDED, 200);
    const bib = new Map<string, BibFields>();
    const notes = new Map<string, CitationNote[]>();

    for (const uri of bibUris.sort((a, b) => a.fsPath.localeCompare(b.fsPath))) {
      const text = await readIfExists(uri.fsPath);
      if (text !== null) {
        for (const [key, fields] of parseBib(text)) {
          if (!bib.has(key)) bib.set(key, fields);
        }
      }
      // Also pick up a sibling <name>.notes.json if present.
      const sibling = uri.fsPath.replace(/\.bib$/i, '.notes.json');
      const siblingText = await readIfExists(sibling);
      if (siblingText !== null) {
        for (const [key, list] of parseNotesFile(siblingText)) notes.set(key, [...(notes.get(key) ?? []), ...list]);
      }
    }

    if (notesPath) {
      const text = await readIfExists(notesPath);
      if (text !== null) {
        for (const [key, list] of parseNotesFile(text)) notes.set(key, list);
      }
    }

    let status = new Map<string, CitationStatus>();
    const statusText = await readIfExists(statusPath);
    if (statusText !== null) status = parseStatusFile(statusText);

    return mergeCitations(bib, notes, status);
  }

  /** Runs the configured status refresh command, or the bundled Research Assistant bridge, in the background. */
  refreshStatus(project: Project): Promise<void> {
    if (!vscode.workspace.isTrusted) return Promise.resolve();
    const config = vscode.workspace.getConfiguration(CONFIG_SECTION, project.folder?.uri);
    const command = config.get<string>('citations.statusCommand', '').trim();
    const statusSetting = config.get<string>('citations.statusFile', '');
    const statusPath = resolveWorkspacePath(statusSetting, project) ?? path.join(project.outDir, 'citation_status.json');
    const builtIn = !command ? this.researchAssistant?.getBuiltInCitationStatusRunner() ?? null : null;
    if (!command && !builtIn) return Promise.resolve();

    if (this.runningCommand) {
      this.pendingRefresh = true;
      return this.runningCommand;
    }

    const cwd = project.folder?.uri.fsPath ?? project.mainDir;
    this.runningCommand = new Promise<void>((resolve) => {
      const child = command
        ? spawn(command, { cwd, shell: true, windowsHide: true })
        : spawn(
            builtIn!.python,
            [builtIn!.script, '--bib-dir', project.mainDir, '--db', builtIn!.dbPath, '--output', statusPath],
            { cwd, windowsHide: true },
          );
      child.on('error', () => resolve());
      child.on('close', (code) => {
        if (code === 0) this.scheduleChanged();
        resolve();
      });
    }).finally(() => {
      this.runningCommand = undefined;
      if (this.pendingRefresh) {
        this.pendingRefresh = false;
        void this.refreshStatus(project);
      }
    });
    return this.runningCommand;
  }

  private scheduleChanged(): void {
    clearTimeout(this.debounce);
    this.debounce = setTimeout(() => this.changed.fire(), WATCH_DEBOUNCE_MS);
  }

  private clearWatchers(): void {
    for (const d of this.watchers) d.dispose();
    this.watchers = [];
  }

  private ensureWatchers(project: Project, notesPath: string | null, statusPath: string): void {
    const key = [project.mainDir, notesPath ?? '', statusPath].join('|');
    if (key === this.watchedKey) return;
    this.watchedKey = key;
    this.clearWatchers();

    const patterns: vscode.RelativePattern[] = [
      new vscode.RelativePattern(vscode.Uri.file(project.mainDir), '**/*.{bib,notes.json}'),
      new vscode.RelativePattern(vscode.Uri.file(path.dirname(statusPath)), path.basename(statusPath)),
    ];
    if (notesPath) {
      patterns.push(new vscode.RelativePattern(vscode.Uri.file(path.dirname(notesPath)), path.basename(notesPath)));
    }

    const notify = () => this.scheduleChanged();
    for (const pattern of patterns) {
      const watcher = vscode.workspace.createFileSystemWatcher(pattern);
      this.watchers.push(watcher, watcher.onDidChange(notify), watcher.onDidCreate(notify), watcher.onDidDelete(notify));
    }
  }
}

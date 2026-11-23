// Works out which document to compile and where its outputs go.

import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { outputPathsFor, type OutputPaths } from './compile.ts';

export const CONFIG_SECTION = 'openLatexStudio';
const REMEMBERED_MAIN = 'openLatexStudio.mainFile';
const DEFAULT_OUT_DIR = '.latex-studio/build';
const EXCLUDED = '**/{node_modules,.git,_Old,.latex-studio}/**';

export interface Project extends OutputPaths {
  folder: vscode.WorkspaceFolder | undefined;
  mainFile: string;
  mainDir: string;
  outDir: string;
}

const DOCUMENT_CLASS = /^[^%\n]*\\documentclass\b/m;
const MAGIC_ROOT = /^\s*%\s*!\s*TEX\s+root\s*=\s*(.+?)\s*$/im;

function samePath(a: string, b: string): boolean {
  return path.relative(a, b) === '';
}

export class ProjectResolver {
  private readonly state: vscode.Memento;

  constructor(state: vscode.Memento) {
    this.state = state;
  }

  async resolve(active: vscode.TextDocument | undefined, interactive: boolean): Promise<Project | undefined> {
    const document = active?.uri.scheme === 'file' ? active : undefined;
    const folder = (document && vscode.workspace.getWorkspaceFolder(document.uri)) ?? vscode.workspace.workspaceFolders?.[0];
    const mainFile = await this.findMainFile(document, folder, interactive);
    if (!mainFile) return undefined;
    return this.projectFor(mainFile, folder);
  }

  /** The project a PDF belongs to, if it is the output (or copied output) of the current main file. */
  async forPdf(pdf: vscode.Uri): Promise<Project | undefined> {
    const project = await this.resolve(undefined, false);
    if (!project) return undefined;
    if (samePath(project.pdfPath, pdf.fsPath)) return project;
    const copyTo = vscode.workspace.getConfiguration(CONFIG_SECTION, project.folder?.uri).get<string>('copyPdfTo', '');
    if (copyTo) {
      const copyPath = path.isAbsolute(copyTo) ? copyTo : path.join(project.folder?.uri.fsPath ?? project.mainDir, copyTo);
      if (samePath(copyPath, pdf.fsPath)) return project;
    }
    return undefined;
  }

  remember(project: Project): Thenable<void> {
    return this.state.update(REMEMBERED_MAIN, project.mainFile);
  }

  private projectFor(mainFile: string, folder: vscode.WorkspaceFolder | undefined): Project {
    const config = vscode.workspace.getConfiguration(CONFIG_SECTION, folder?.uri);
    const mainDir = path.dirname(mainFile);
    const setting = config.get<string>('outDir', DEFAULT_OUT_DIR) || DEFAULT_OUT_DIR;
    const outDir = path.isAbsolute(setting) ? setting : path.join(folder?.uri.fsPath ?? mainDir, setting);
    return { folder, mainFile, mainDir, outDir, ...outputPathsFor(mainFile, outDir) };
  }

  private async findMainFile(
    document: vscode.TextDocument | undefined,
    folder: vscode.WorkspaceFolder | undefined,
    interactive: boolean,
  ): Promise<string | undefined> {
    const setting = vscode.workspace.getConfiguration(CONFIG_SECTION, folder?.uri).get<string>('mainFile', '');
    if (setting) {
      const file = path.isAbsolute(setting) ? setting : path.join(folder?.uri.fsPath ?? '', setting);
      if (fs.existsSync(file)) return file;
      void vscode.window.showWarningMessage(`Open LaTeX Studio: the configured main file "${setting}" does not exist.`);
      return undefined;
    }

    if (document) {
      const text = document.getText();
      const magic = MAGIC_ROOT.exec(text.split('\n', 30).join('\n'));
      if (magic) {
        const root = path.resolve(path.dirname(document.uri.fsPath), magic[1]);
        if (fs.existsSync(root)) return root;
      }
      if (DOCUMENT_CLASS.test(text)) return document.uri.fsPath;
    }

    const remembered = this.state.get<string>(REMEMBERED_MAIN);
    if (remembered && fs.existsSync(remembered)) return remembered;

    return this.searchWorkspace(folder, interactive);
  }

  private async searchWorkspace(folder: vscode.WorkspaceFolder | undefined, interactive: boolean): Promise<string | undefined> {
    if (!folder) return undefined;
    const files = await vscode.workspace.findFiles(new vscode.RelativePattern(folder, '**/*.tex'), EXCLUDED, 2000);
    const candidates = files.map((uri) => uri.fsPath).filter(hasDocumentClass);
    if (candidates.length <= 1) return candidates[0];
    if (!interactive) return undefined;

    const items = candidates
      .map((file) => ({ label: path.relative(folder.uri.fsPath, file), file }))
      .sort((a, b) => Number(path.basename(b.file) === 'main.tex') - Number(path.basename(a.file) === 'main.tex'));
    const picked = await vscode.window.showQuickPick(items, { placeHolder: 'Which document should Open LaTeX Studio compile?' });
    if (picked) await this.state.update(REMEMBERED_MAIN, picked.file);
    return picked?.file;
  }
}

function hasDocumentClass(file: string): boolean {
  try {
    return DOCUMENT_CLASS.test(fs.readFileSync(file, 'utf8'));
  } catch {
    return false;
  }
}

/** Keeps build output out of version control when the default output folder is used. */
export function ignoreDefaultOutDir(project: Project): void {
  const relative = project.folder && path.relative(project.folder.uri.fsPath, project.outDir).split(path.sep).join('/');
  if (relative !== DEFAULT_OUT_DIR) return;
  const ignore = path.join(project.folder!.uri.fsPath, '.latex-studio', '.gitignore');
  if (fs.existsSync(ignore)) return;
  fs.mkdirSync(path.dirname(ignore), { recursive: true });
  fs.writeFileSync(ignore, '*\n');
}

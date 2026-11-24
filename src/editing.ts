// Writing help inside the editor: completion, outline, word count and insert commands.

import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseBib, shortAuthors, venueOf, type BibFields } from './bib.ts';
import { completionContext, parseHeadings, parseLabels, projectFiles, stripComments, textStats, type TextStats } from './latex.ts';
import { CONFIG_SECTION, type ProjectResolver } from './project.ts';

const SELECTOR: vscode.DocumentSelector = [{ language: 'latex' }, { language: 'tex' }];
const EXCLUDED = '**/{node_modules,.git,_Old,.scriptorium}/**';
const STATUS_DEBOUNCE_MS = 300;

const ENVIRONMENTS = [
  'abstract', 'algorithm', 'align', 'align*', 'center', 'corollary', 'definition', 'description', 'document',
  'enumerate', 'equation', 'equation*', 'example', 'figure', 'figure*', 'gather', 'itemize', 'lemma', 'lstlisting',
  'longtable', 'minipage', 'proof', 'quotation', 'quote', 'remark', 'spacing', 'subfigure', 'table', 'table*',
  'tabular', 'theorem', 'tikzpicture', 'verbatim',
];

// Snippet syntax: \\ is a backslash and \$ a dollar sign.
const WRAP_COMMANDS: Record<string, string> = {
  bold: '\\\\textbf{${TM_SELECTED_TEXT}$0}',
  italic: '\\\\textit{${TM_SELECTED_TEXT}$0}',
  math: '\\$${TM_SELECTED_TEXT}$0\\$',
};

const REFERENCE_COMMANDS: Record<string, string> = {
  cite: '\\\\cite{$0}',
  ref: '\\\\ref{$0}',
};

const BLOCK_COMMANDS: Record<string, string> = {
  figure: [
    '\\\\begin{figure}[htbp]',
    '\t\\\\centering',
    '\t\\\\includegraphics[width=0.85\\\\textwidth]{${1:figures/sample.png}}',
    '\t\\\\caption{${2:Caption}}',
    '\t\\\\label{fig:${3:sample}}',
    '\\\\end{figure}',
    '$0',
  ].join('\n'),
  table: [
    '\\\\begin{table}[htbp]',
    '\t\\\\centering',
    '\t\\\\caption{${1:Caption}}',
    '\t\\\\label{tab:${2:sample}}',
    '\t\\\\begin{tabular}{${3:lcr}}',
    '\t\t\\\\hline',
    '\t\tItem & Description & Value \\\\\\\\',
    '\t\t\\\\hline',
    '\t\t$0',
    '\t\t\\\\hline',
    '\t\\\\end{tabular}',
    '\\\\end{table}',
  ].join('\n'),
  itemize: ['\\\\begin{itemize}', '\t\\\\item $1', '\t\\\\item $0', '\\\\end{itemize}'].join('\n'),
};

export interface WordReport {
  files: { file: string; relative: string; stats: TextStats }[];
  total: TextStats;
}

function normalize(file: string): string {
  return process.platform === 'win32' ? file.toLowerCase() : file;
}

function openDocument(file: string): vscode.TextDocument | undefined {
  const wanted = normalize(file);
  return vscode.workspace.textDocuments.find((d) => d.uri.scheme === 'file' && normalize(d.uri.fsPath) === wanted);
}

/** Reads a source file, preferring unsaved text from an open editor. */
function readSource(file: string): string | null {
  const open = openDocument(file);
  if (open) return open.getText();
  try {
    return fs.statSync(file).isFile() ? fs.readFileSync(file, 'utf8') : null;
  } catch {
    return null;
  }
}

interface CachedFile {
  stamp: string;
  bib?: Map<string, BibFields>;
  labels?: { label: string; line: number }[];
}

export class EditingFeatures implements vscode.Disposable {
  private readonly subscriptions: vscode.Disposable[] = [];
  private readonly status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
  private readonly cache = new Map<string, CachedFile>();
  private readonly projects: ProjectResolver;
  private statusTimer: NodeJS.Timeout | undefined;

  constructor(projects: ProjectResolver) {
    this.projects = projects;
    this.status.command = 'openScriptorium.wordCount';
    this.status.tooltip = 'Words in this file. Click for the whole document.';

    const commands: [string, () => unknown][] = [
      ['openScriptorium.wordCount', () => this.showWordReport()],
      ...Object.entries(WRAP_COMMANDS).map(([name, snippet]): [string, () => unknown] => [`openScriptorium.insert.${name}`, () => this.insert(snippet)]),
      ...Object.entries(BLOCK_COMMANDS).map(([name, snippet]): [string, () => unknown] => [`openScriptorium.insert.${name}`, () => this.insert(snippet)]),
      ...Object.entries(REFERENCE_COMMANDS).map(([name, snippet]): [string, () => unknown] => [
        `openScriptorium.insert.${name}`,
        async () => {
          await this.insert(snippet);
          await vscode.commands.executeCommand('editor.action.triggerSuggest');
        },
      ]),
    ];

    this.subscriptions.push(
      this.status,
      vscode.languages.registerCompletionItemProvider(SELECTOR, { provideCompletionItems: (d, p) => this.complete(d, p) }, '{', ','),
      vscode.languages.registerDocumentSymbolProvider(SELECTOR, { provideDocumentSymbols: (d) => this.symbols(d) }),
      vscode.window.onDidChangeActiveTextEditor(() => this.updateStatusNow()),
      vscode.workspace.onDidChangeTextDocument(({ document }) => {
        if (document === vscode.window.activeTextEditor?.document) this.scheduleStatus();
      }),
      ...commands.map(([id, handler]) => vscode.commands.registerCommand(id, handler)),
    );
    this.updateStatusNow();
  }

  dispose(): void {
    clearTimeout(this.statusTimer);
    for (const subscription of this.subscriptions) subscription.dispose();
  }

  get statusText(): string {
    return this.status.text;
  }

  private enabled(document: vscode.TextDocument): boolean {
    return vscode.workspace.getConfiguration(CONFIG_SECTION, document.uri).get<boolean>('languageFeatures.enabled', true);
  }

  // ---- Completion ---------------------------------------------------------------------------

  private async complete(document: vscode.TextDocument, position: vscode.Position): Promise<vscode.CompletionItem[] | undefined> {
    if (!this.enabled(document)) return undefined;
    const before = document.lineAt(position.line).text.slice(0, position.character);
    if (stripComments(before) !== before) return undefined;
    const context = completionContext(before);
    if (!context) return undefined;
    const range = new vscode.Range(position.line, context.column, position.line, position.character);

    if (context.kind === 'env') {
      return ENVIRONMENTS.map((name) => {
        const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Struct);
        item.range = range;
        return item;
      });
    }

    const index = await this.indexFor(document);
    if (context.kind === 'cite') {
      return [...index.citations].map(([key, { fields }]) => {
        const authors = shortAuthors(fields.author);
        const item = new vscode.CompletionItem(
          { label: key, description: [authors, fields.year].filter(Boolean).join(' ') },
          vscode.CompletionItemKind.Reference,
        );
        item.range = range;
        item.sortText = key;
        item.filterText = [key, fields.author, fields.title].filter(Boolean).join(' ');
        item.documentation = new vscode.MarkdownString(
          [`**${fields.title ?? key}**`, fields.author, [venueOf(fields), fields.year].filter(Boolean).join(', ')].filter(Boolean).join('\n\n'),
        );
        return item;
      });
    }

    return index.labels.map(({ label, file }) => {
      const item = new vscode.CompletionItem({ label, description: path.basename(file) }, vscode.CompletionItemKind.Reference);
      item.range = range;
      return item;
    });
  }

  private async indexFor(document: vscode.TextDocument) {
    const project = await this.projects.resolve(document, false);
    const root =
      project?.mainDir ?? vscode.workspace.getWorkspaceFolder(document.uri)?.uri.fsPath ?? path.dirname(document.uri.fsPath);
    const files = await vscode.workspace.findFiles(new vscode.RelativePattern(vscode.Uri.file(root), '**/*.{tex,bib}'), EXCLUDED, 5000);

    const citations = new Map<string, { fields: BibFields; file: string }>();
    const labels: { label: string; file: string }[] = [];
    for (const { fsPath: file } of files) {
      const parsed = this.parsed(file);
      if (!parsed) continue;
      for (const [key, fields] of parsed.bib ?? []) if (!citations.has(key)) citations.set(key, { fields, file });
      for (const { label } of parsed.labels ?? []) labels.push({ label, file });
    }
    return { citations, labels };
  }

  private parsed(file: string): CachedFile | null {
    const open = openDocument(file);
    let stamp: string;
    if (open?.isDirty) {
      stamp = `v${open.version}`;
    } else {
      try {
        stamp = `m${fs.statSync(file).mtimeMs}`;
      } catch {
        return null;
      }
    }
    const key = normalize(file);
    const cached = this.cache.get(key);
    if (cached?.stamp === stamp) return cached;
    const text = readSource(file);
    if (text === null) return null;
    const entry: CachedFile = file.toLowerCase().endsWith('.bib') ? { stamp, bib: parseBib(text) } : { stamp, labels: parseLabels(text) };
    this.cache.set(key, entry);
    return entry;
  }

  // ---- Outline ------------------------------------------------------------------------------

  private symbols(document: vscode.TextDocument): vscode.DocumentSymbol[] | undefined {
    if (!this.enabled(document)) return undefined;
    const headings = parseHeadings(document.getText());
    const roots: vscode.DocumentSymbol[] = [];
    const stack: { level: number; symbol: vscode.DocumentSymbol }[] = [];

    headings.forEach((heading, index) => {
      const next = headings.slice(index + 1).find((h) => h.level <= heading.level);
      const lastLine = next ? Math.max(heading.line, next.line - 1) : document.lineCount - 1;
      const full = new vscode.Range(heading.line, heading.start, lastLine, document.lineAt(lastLine).text.length);
      const selection = new vscode.Range(heading.line, heading.start, heading.line, heading.end);
      const symbol = new vscode.DocumentSymbol(heading.title, '', vscode.SymbolKind.Module, full, selection);

      while (stack.length && stack[stack.length - 1].level >= heading.level) stack.pop();
      if (stack.length) stack[stack.length - 1].symbol.children.push(symbol);
      else roots.push(symbol);
      stack.push({ level: heading.level, symbol });
    });
    return roots;
  }

  // ---- Word count ---------------------------------------------------------------------------

  private scheduleStatus(): void {
    clearTimeout(this.statusTimer);
    this.statusTimer = setTimeout(() => this.updateStatusNow(), STATUS_DEBOUNCE_MS);
  }

  private updateStatusNow(): void {
    const document = vscode.window.activeTextEditor?.document;
    if (!document || !['latex', 'tex'].includes(document.languageId) || !document.fileName.toLowerCase().endsWith('.tex')) {
      this.status.hide();
      return;
    }
    this.status.text = `$(book) ${textStats(document.getText()).words.toLocaleString('en-US')} words`;
    this.status.show();
  }

  async wordReport(document: vscode.TextDocument | undefined): Promise<WordReport | undefined> {
    const project = await this.projects.resolve(document, true);
    if (!project) return undefined;
    const total: TextStats = { words: 0, headings: 0, math: 0 };
    const files = projectFiles(path.resolve(project.mainFile), readSource)
      .filter((f) => !f.preamble)
      .map(({ file, text }) => {
        const stats = textStats(text);
        total.words += stats.words;
        total.headings += stats.headings;
        total.math += stats.math;
        return { file, relative: path.relative(project.mainDir, file).split(path.sep).join('/'), stats };
      });
    return { files, total };
  }

  private async showWordReport(): Promise<void> {
    const report = await this.wordReport(vscode.window.activeTextEditor?.document);
    if (!report) return;
    const { words, headings, math } = report.total;
    const picked = await vscode.window.showQuickPick(
      report.files.map((f) => ({
        label: f.relative,
        description: `${f.stats.words.toLocaleString('en-US')} words`,
        detail: `${f.stats.headings} headings, ${f.stats.math} formulas`,
        file: f.file,
      })),
      {
        title: `${words.toLocaleString('en-US')} words, ${headings} headings, ${math} formulas, ${report.files.length} files`,
        placeHolder: 'Pick a file to open it',
        matchOnDescription: true,
      },
    );
    if (picked) await vscode.window.showTextDocument(vscode.Uri.file(picked.file));
  }

  // ---- Insert commands ----------------------------------------------------------------------

  private async insert(snippet: string): Promise<void> {
    await vscode.window.activeTextEditor?.insertSnippet(new vscode.SnippetString(snippet));
  }
}

# Open LaTeX Studio

A LaTeX writing studio inside VS Code. Compile with [Tectonic](https://tectonic-typesetting.github.io/), read the PDF beside your source, and jump between the two down to the exact word.

> **Status: early development (0.0.1).** There is no packaged release yet, so for now you run it from source. It has been tested on Windows with VS Code 1.105; macOS and Linux have not been tried.

## Features

**Compile**

- Compiles on save, while you type, or only on request.
- One build at a time. Anything you ask for during a build is merged into a single follow-up, so no change is lost.
- A failed build keeps the last good PDF on screen.
- Errors, warnings and bad boxes appear in the Problems panel, on the right file and line. Warnings from inside packages stay in the log.

**PDF preview**

- Opens as a normal editor tab beside your source.
- Keeps your reading position across recompiles, without flashing an empty page.
- Follows VS Code's theme and works offline: PDF.js ships inside the extension.

**Two-way SyncTeX**

- From source to PDF: highlights the typeset line for your cursor, even inside a long paragraph.
- From PDF to source: double-click a word to select that same word in the source.
- Written in TypeScript, so no `synctex` binary is needed.

**Writing help**

- Completion for `\cite`, `\ref` and `\begin`. Citations show author and year, and you can search by key, author or title.
- Outline and breadcrumbs, nested by heading level.
- Word count for the current file in the status bar, and a file-by-file report for the whole document. Text inside commands like `\textbf` counts; math and references do not.
- Insert commands for bold, italic, math, citations, references, figures, tables and lists.

## Getting started

You need:

- VS Code 1.99 or newer
- [Tectonic](https://tectonic-typesetting.github.io/book/latest/installation/), on your `PATH` or set in `openLatexStudio.tectonicPath`
- [Node.js](https://nodejs.org/) LTS, to build from source

Build it:

```bash
git clone https://github.com/stevieTheTurtle/open-latex-studio.git
cd open-latex-studio
npm ci
npm run build
```

Then start VS Code with the extension loaded, pointing it at your LaTeX project:

```bash
code --extensionDevelopmentPath="$PWD" /path/to/your/latex/project
```

Open a `.tex` file and press `Ctrl+Enter`. The first build can take a couple of minutes while Tectonic downloads the TeX files it needs; later builds are much faster.

## Keyboard shortcuts

| Shortcut | Action | Where |
|---|---|---|
| `Ctrl+Enter` | Compile | LaTeX file or PDF tab |
| `Ctrl+Alt+Right` | Go to this location in the PDF | LaTeX file |
| `Ctrl+Alt+Left` | Go to this location in the source | PDF tab |
| Double-click | Go to this word in the source | PDF tab |
| `Ctrl+B` / `Ctrl+I` | Bold / italic | LaTeX file |
| `Ctrl+Scroll` | Zoom | PDF tab |

On macOS, use `Cmd` in place of `Ctrl`. All commands are also in the Command Palette under **Open LaTeX Studio**.

## Settings

| Setting | Default | Description |
|---|---|---|
| `openLatexStudio.mainFile` | *(empty)* | Document to compile, relative to the workspace folder |
| `openLatexStudio.outDir` | `.latex-studio/build` | Folder for the PDF and SyncTeX files |
| `openLatexStudio.copyPdfTo` | *(empty)* | Also copy the PDF here after a successful build |
| `openLatexStudio.tectonicPath` | *(empty)* | Tectonic executable; empty means look on `PATH` |
| `openLatexStudio.compile.trigger` | `save` | `save`, `typing` or `off` |
| `openLatexStudio.compile.typingDelayMs` | `2800` | Wait after the last keystroke in `typing` mode |
| `openLatexStudio.languageFeatures.enabled` | `true` | Completion and outline; turn off if another LaTeX extension provides them |
| `openLatexStudio.formatKeybindings` | `true` | `Ctrl+B` and `Ctrl+I` in LaTeX files, which replace the sidebar and inline chat shortcuts there |

If `mainFile` is empty, the document to compile is chosen in this order: a `% !TEX root = ...` comment, the open file if it has `\documentclass`, the last document you compiled, then a search of the workspace.

The default output folder ignores itself in Git, so build files stay out of your repository.

## Security and privacy

- Compiling only runs in [trusted workspaces](https://code.visualstudio.com/docs/editor/workspace-trust). In other workspaces you can still view PDFs.
- Tectonic always runs with `--untrusted`, which keeps shell-escape off whatever the document asks for.
- There is no local server and no open port. The preview talks to the extension through VS Code's own messaging.
- The extension collects no telemetry. Tectonic itself downloads TeX packages from its bundle server when it needs them.

## Roadmap

- Citation evidence: hover a citation in the PDF or the source to see the passage that backs it, with optional markers for references you haven't verified
- Automatic Tectonic installation on first use
- Packaged `.vsix` releases, then the VS Code Marketplace and Open VSX
- Tested on macOS and Linux

## Development

```bash
npm run build       # bundle the extension and the viewer into dist/
npm run typecheck   # type-check everything
npm test            # unit tests for parsers, build logic and word count
```

The end-to-end suite opens a real, isolated VS Code window with a throwaway profile and drives compile, preview and SyncTeX on a small test document. On Windows:

```powershell
.\scripts\run-e2e.ps1 -Exe "<path to Code.exe>" -WorkDir "<empty scratch folder>" -Tectonic "<path to tectonic.exe>"
```

| Path | Contents |
|---|---|
| `src/extension.ts` | Activation and commands |
| `src/session.ts`, `src/compile.ts` | Build queue, Tectonic runner, diagnostics |
| `src/project.ts` | Finding the main file and output paths |
| `src/viewer.ts`, `src/webview/` | PDF tab and the PDF.js page inside it |
| `src/synctex.ts`, `src/reveal.ts` | SyncTeX lookups and exact-word matching |
| `src/editing.ts`, `src/latex.ts`, `src/bib.ts` | Completion, outline, word count, insert commands |
| `test/` | Unit tests and the end-to-end suite |

The build uses PDF.js's legacy bundle on purpose: the modern one needs browser features missing from the Chromium in older VS Code versions.

## License

[MIT](LICENSE). The extension bundles [PDF.js](https://github.com/mozilla/pdf.js), licensed under Apache-2.0. [Tectonic](https://github.com/tectonic-typesetting/tectonic) is MIT-licensed and installed separately.

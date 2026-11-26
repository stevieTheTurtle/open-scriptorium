<p align="center">
  <img src="assets/banner.png" alt="Open Scriptorium — Local LaTeX Studio + Bundled Research Assistant" width="100%" />
</p>

<p align="center">
  <a href="https://marketplace.visualstudio.com/items?itemName=stevieTheTurtle.open-scriptorium"><img src="https://img.shields.io/visual-studio-marketplace/v/stevieTheTurtle.open-scriptorium?label=VS%20Code%20Marketplace&color=2B4666" alt="VS Code Marketplace Version" /></a>
  <a href="https://marketplace.visualstudio.com/items?itemName=stevieTheTurtle.open-scriptorium"><img src="https://img.shields.io/visual-studio-marketplace/i/stevieTheTurtle.open-scriptorium?label=Installs&color=2E5A44" alt="VS Code Marketplace Installs" /></a>
  <a href="https://github.com/stevieTheTurtle/open-scriptorium/releases/latest"><img src="https://img.shields.io/github/v/release/stevieTheTurtle/open-scriptorium?label=Release&color=8B2635" alt="Latest GitHub Release" /></a>
  <a href="https://github.com/stevieTheTurtle/open-scriptorium/actions/workflows/ci.yml"><img src="https://github.com/stevieTheTurtle/open-scriptorium/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/stevieTheTurtle/open-scriptorium?color=9A6B1E" alt="MIT License" /></a>
</p>

# Open Scriptorium

A free and open-source local LaTeX writing studio for **VS Code** and **Antigravity IDE** with a bundled **Research Assistant** — combining auto-installed [Tectonic](https://tectonic-typesetting.github.io/) compilation, side-by-side PDF.js preview with exact-word SyncTeX, [Zotero](https://www.zotero.org/) library sync, a fast CLI-first local paper knowledge base (with opt-in [MCP](https://modelcontextprotocol.io/) fallback), and verbatim citation verification.

> **New PC or AI Agent setting this up?** Read the complete end-to-end guide in **[SETUP.md](SETUP.md)** — it covers installing Open Scriptorium in VS Code / Antigravity, connecting [Zotero](https://www.zotero.org/) (with [Better BibTeX](https://retorque.re/zotero-better-bibtex/) `@citekey` support), setting up the bundled Research Assistant (`ra` CLI, warm daemon, and optional MCP server), sharing your paper index across PCs, and both 1-click GUI and headless CLI/agent setup.

## Architecture

<p align="center">
  <img src="assets/architecture.png" alt="Open Scriptorium and Research Assistant architecture" width="100%" />
</p>

## Citation Verification at a Glance

<p align="center">
  <img src="assets/citation-states.png" alt="PDF citation verification states: Verified, Second-hand, Unverified" width="100%" />
</p>

## Features

**Bundled Research Assistant (`ra` CLI + Zotero + Citation Evidence + Opt-In MCP)**

- **Built-in [Zotero](https://www.zotero.org/) integration**: incrementally indexes PDF attachments (imported or linked) from a read-only snapshot of `zotero.sqlite` — preserving titles, authors, collections, tags, and [Better BibTeX](https://retorque.re/zotero-better-bibtex/) `@citekey` tags without ever locking or modifying your Zotero database. Supports on-demand sync or a background timer (`openScriptorium.researchAssistant.zoteroSyncIntervalMinutes`).
- **Low-token CLI-first paper knowledge base (`ra`)**: ships the full Research Assistant Python package (`research-assistant/` — hybrid SQLite FTS5 + ChromaDB semantic search via offline `sentence-transformers` or [Ollama](https://ollama.com/), plus optional arXiv search) and `citation-evidence` agent skill/rules (`agent-plugin/`). A warm local HTTP daemon (`openScriptorium.researchAssistant.autoStartDaemon`) keeps `ra search` responses at ~50 ms, while stdlib-only `ra notes add/get/audit` and `ra bib get` manage citation evidence notes and BibTeX lookups instantaneously.
- **Opt-in [MCP](https://modelcontextprotocol.io/) fallback**: enable `openScriptorium.researchAssistant.mcpFallback` if an AI client does not have shell access and needs the bundled stdio FastMCP server.
- **1-click multi-PC setup**: run `Open Scriptorium: Research Assistant: Set Up / Configure` from the Command Palette on any new PC. It creates a stable `~/.open-scriptorium/research-assistant/.venv`, connects to a local or cloud-synced `data/` index (e.g. OneDrive) and [Zotero](https://www.zotero.org/), generates `ra` / `ra-ui` / `ra-mcp` / `ra-zotero-sync` launchers, and automatically registers:
  - **Antigravity IDE** plugin (`~/.gemini/config/plugins/open-scriptorium-research/` — `citation-evidence` skill + always-on rules + logo, plus optional MCP server)
  - **Claude Code CLI** (`~/.claude/skills/citation-evidence/SKILL.md`, plus optional `~/.claude.json` MCP server)
  - **VS Code** (`mcpServerDefinitionProviders` + user `mcp.json` when MCP fallback is enabled)
- **Automatic PDF citation verification**: a stdlib-only citation bridge matches `.bib` entries against your Zotero index and highlights citations in the PDF preview — **Verified** (with verbatim quote + page tooltips from `references.notes.json`), **Second-hand (yellow)** with extracted citing phrases from papers in your library, and **Unverified (red)**.
- **Find Supporting Citation in Zotero (`Ctrl+Alt+C`)**: select a claim in either a `.tex` file or the PDF preview tab (via right-click menu, floating PDF selection pill, or `Ctrl+Alt+C`). Open Scriptorium strips LaTeX/PDF artifacts, runs local zero-LLM hybrid recall (ChromaDB + OR-based FTS5 BM25) → local `sentence-transformers` CrossEncoder reranking → sentence-level verbatim quote extraction via the warm daemon, and opens ranked results in a side panel with one-click `\cite{key}` insertion (smartly merging into adjacent `\cite{...}`) and `references.notes.json` logging.
- **Local Web UI**: launch the Research Assistant Web UI (`http://127.0.0.1:8000`) directly from the Command Palette or LaTeX toolbar to upload PDFs, browse collections, edit tags, and test queries.

**Compile**

- Compiles on save, while you type, or only on request with [Tectonic](https://tectonic-typesetting.github.io/), with a live compile status indicator and quick Auto-compile toggle right in the PDF toolbar.
- **Automatic Tectonic setup**: if Tectonic is not on `PATH` (and `openScriptorium.tectonicPath` is empty), Open Scriptorium downloads and verifies the official prebuilt binary into `~/.open-scriptorium/bin/` on first compile (or anytime via `Open Scriptorium: Install / Update Tectonic`).
- One build at a time. Anything you ask for during a build is merged into a single follow-up, so no change is lost.
- A failed build keeps the last good PDF on screen.
- Errors, warnings and bad boxes appear in the Problems panel, on the right file and line. Warnings from inside packages stay in the log.

**PDF preview**

- Opens as a normal editor tab beside your source.
- Keeps your reading position across recompiles, without flashing an empty page.
- Resizable hierarchical PDF outline navigator, in-PDF text search (`Ctrl+F` with case-sensitivity toggle and match counter), and `Ctrl+Click` hyperlinks (URLs, citations, cross-references, TOC) with `Alt+Left` back navigation.
- Follows VS Code's theme and works offline: PDF.js ships inside the extension.

**Two-way SyncTeX**

- From source to PDF: highlights the typeset line for your cursor, even inside a long paragraph.
- From PDF to source: double-click a word to select that same word in the source.
- Written in TypeScript, so no `synctex` binary is needed.

**Writing help**

- Completion for `\cite`, `\ref` and `\begin`. Citations show author and year, and you can search by key, author or title.
- Outline and breadcrumbs, nested by heading level.
- Word count for the current file in the status bar, and a file-by-file report for the whole document. Text inside commands like `\textbf` counts; math and references do not.
- Insert commands for bold, italic, math, citations, references, figures, tables and lists, plus a dedicated **Research Assistant** menu on the LaTeX editor toolbar.

## Getting started

For full setup instructions (including Research Assistant CLI/MCP, Zotero sync, Antigravity IDE plugin, Claude Code, VS Code, and multi-PC setup for humans or AI agents), see **[SETUP.md](SETUP.md)**.

### Quick start

You need:

- VS Code 1.99+ or Antigravity IDE
- [Tectonic](https://tectonic-typesetting.github.io/book/latest/installation/) *(installed automatically on first compile into `~/.open-scriptorium/bin/`, or use your own via `PATH` / `openScriptorium.tectonicPath`)*
- Python 3.10+ *(for the bundled Research Assistant CLI/MCP & citation verification)*
- [Zotero](https://www.zotero.org/) *(optional, recommended — with [Better BibTeX](https://retorque.re/zotero-better-bibtex/) for `@citekey` matching)*
- [Node.js](https://nodejs.org/) LTS *(only if building the `.vsix` from source)*

Install **Open Scriptorium** (`stevieTheTurtle.open-scriptorium`) from the **[VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=stevieTheTurtle.open-scriptorium)**, grab the latest `.vsix` from **[GitHub Releases](https://github.com/stevieTheTurtle/open-scriptorium/releases)** (ideal for Antigravity IDE, Cursor, or offline installs), or build from source:

```bash
git clone https://github.com/stevieTheTurtle/open-scriptorium.git
cd open-scriptorium
npm ci
npm run package
```

Install a `.vsix` via **Extensions → `...` → Install from VSIX...** (or `code --install-extension open-scriptorium-<version>.vsix`), then:

1. Open a `.tex` file and press `Ctrl+Enter` (`Cmd+Enter` on macOS) to compile and preview.
2. Run **`Open Scriptorium: Research Assistant: Set Up / Configure`** from the Command Palette to create `~/.open-scriptorium/research-assistant/.venv`, connect your paper index & Zotero library, and register the `ra` CLI + `citation-evidence` skill (and optional MCP server) across Antigravity IDE, Claude Code, and VS Code.

## Keyboard shortcuts

| Shortcut | Action | Where |
|---|---|---|
| `Ctrl+Enter` | Compile | LaTeX file or PDF tab |
| `Ctrl+Alt+Right` | Go to this location in the PDF | LaTeX file |
| `Ctrl+Alt+Left` | Go to this location in the source | PDF tab |
| `Ctrl+Alt+C` | Find Supporting Citation in Zotero for selected text | LaTeX file or PDF tab |
| Double-click | Go to this word in the source | PDF tab |
| `Ctrl+F` | Find text in PDF (`Enter` / `Shift+Enter` next/prev, `Esc` close) | PDF tab |
| `Ctrl+Click` | Follow PDF hyperlink (URL, citation, cross-reference, TOC) | PDF tab |
| `Alt+Left` | Jump back after following an internal PDF link | PDF tab |
| `Ctrl+B` / `Ctrl+I` | Bold / italic | LaTeX file |
| `Ctrl+Scroll` | Zoom | PDF tab |

On macOS, use `Cmd` in place of `Ctrl`. All commands are also in the Command Palette under **Open Scriptorium**.

## Settings

| Setting | Default | Description |
|---|---|---|
| `openScriptorium.mainFile` | *(empty)* | Document to compile, relative to the workspace folder |
| `openScriptorium.outDir` | `.scriptorium/build` | Folder for the PDF and SyncTeX files |
| `openScriptorium.copyPdfTo` | *(empty)* | Also copy the PDF here after a successful build |
| `openScriptorium.tectonicPath` | *(empty)* | Tectonic executable; empty uses `PATH` or `~/.open-scriptorium/bin/` |
| `openScriptorium.tectonic.autoInstall` | `true` | Automatically download Tectonic into `~/.open-scriptorium/bin/` on first compile when not found |
| `openScriptorium.compile.trigger` | `save` | `save`, `typing` or `off` |
| `openScriptorium.compile.typingDelayMs` | `2800` | Wait after the last keystroke in `typing` mode |
| `openScriptorium.languageFeatures.enabled` | `true` | Completion and outline; turn off if another LaTeX extension provides them |
| `openScriptorium.formatKeybindings` | `true` | `Ctrl+B` and `Ctrl+I` in LaTeX files, which replace the sidebar and inline chat shortcuts there |
| `openScriptorium.citations.notesFile` | *(empty)* | Path to a citation evidence notes JSON file (e.g. `01_Thesis_meta/references.notes.json`) |
| `openScriptorium.citations.statusFile` | *(empty)* | Path to citation status JSON (defaults to `<outDir>/citation_status.json`) |
| `openScriptorium.citations.statusCommand` | *(empty)* | Optional custom command to refresh citation status (empty uses the bundled Research Assistant bridge) |
| `openScriptorium.citations.citeCommand` | `\cite` | Default LaTeX citation command inserted by Find Supporting Citation (`\cite`, `\citep`, `\citet`, `\parencite`, `\textcite`, `\autocite`) |
| `openScriptorium.researchAssistant.enabled` | `true` | Enable bundled Research Assistant citation checks, CLI/MCP integration, and Zotero sync |
| `openScriptorium.researchAssistant.installDir` | *(empty)* | Stable install folder for Research Assistant (defaults to `~/.open-scriptorium/research-assistant`) |
| `openScriptorium.researchAssistant.pythonPath` | *(empty)* | Optional Python 3.10+ executable override for citation checks and initial setup |
| `openScriptorium.researchAssistant.dataDir` | *(empty)* | Research Assistant `data/` folder (auto-detects OneDrive or `<installDir>/data`) |
| `openScriptorium.researchAssistant.zoteroDir` | *(empty)* | Zotero folder containing `zotero.sqlite` (auto-detected if empty) |
| `openScriptorium.researchAssistant.collection` | `Zotero` | Collection name used for citation verification and Zotero sync |
| `openScriptorium.researchAssistant.zoteroSyncIntervalMinutes` | `0` | Periodic background Zotero sync interval in minutes (`0` = manual only) |
| `openScriptorium.researchAssistant.webUiPort` | `8000` | Local port for the Research Assistant Web UI and warm CLI daemon |
| `openScriptorium.researchAssistant.autoStartDaemon` | `true` | Keep the local HTTP service warm in the background for ~50 ms `ra` CLI searches and instant Web UI |
| `openScriptorium.researchAssistant.mcpFallback` | `false` | Also register the stdio Research Assistant MCP server (opt-in fallback for clients without shell access) |
| `openScriptorium.researchAssistant.rerankerModel` | `cross-encoder/ms-marco-MiniLM-L-6-v2` | Local `sentence-transformers` CrossEncoder model for Find Supporting Citation in Zotero |

If `mainFile` is empty, the document to compile is chosen in this order: a `% !TEX root = ...` comment, the open file if it has `\documentclass`, the last document you compiled, then a search of the workspace.

The default output folder ignores itself in Git, so build files stay out of your repository.

## Security and privacy

- Compiling and Research Assistant scripts only run in [trusted workspaces](https://code.visualstudio.com/docs/editor/workspace-trust). In other workspaces you can still view PDFs.
- Tectonic always runs with `--untrusted`, which keeps shell-escape off whatever the document asks for.
- The PDF preview runs with no open port — it talks to the extension through VS Code's own messaging. The local Research Assistant daemon and Web UI bind to `127.0.0.1` only.
- Your paper index (`metadata.db` and ChromaDB vectors) stays 100% local, and Zotero sync always reads a temporary snapshot copy of `zotero.sqlite` so your live [Zotero](https://www.zotero.org/) database is never locked or modified.
- The extension collects no telemetry. Tectonic downloads TeX packages from its bundle server on demand, and optional arXiv search is only queried when explicitly requested.

## Roadmap

- [x] Citation evidence: hover a citation in the PDF to see verbatim quotes, second-hand citing phrases, and Zotero verification markers
- [x] Bundled Research Assistant (`ra` CLI, warm local daemon, opt-in MCP server, Zotero sync, and 1-click multi-PC setup)
- [x] PDF outline navigator, in-PDF search (`Ctrl+F`), and `Ctrl+Click` hyperlink navigation
- [x] Packaged `.vsix` releases
- [x] Automatic Tectonic installation on first use
- [x] VS Code Marketplace publishing (`stevieTheTurtle.open-scriptorium`)
- [ ] Open VSX Registry publishing
- [ ] Full macOS and Linux verification

## Development

```bash
npm run build       # bundle the extension and the viewer into dist/
npm run typecheck   # type-check everything
npm test            # unit tests for parsers, build logic, installer, citations, and Research Assistant
```

The end-to-end suite opens a real, isolated VS Code window with a throwaway profile and drives compile, preview and SyncTeX on a small test document. On Windows:

```powershell
.\scripts\run-e2e.ps1 -Exe "<path to Code.exe>" -WorkDir "<empty scratch folder>" -Tectonic "<path to tectonic.exe>"
```

| Path | Contents |
|---|---|
| `SETUP.md` | Full end-to-end setup guide for users and AI agents (VS Code, Antigravity, CLI/MCP, Zotero) |
| `src/extension.ts` | Activation and commands |
| `src/session.ts`, `src/compile.ts`, `src/tectonicInstaller.ts` | Build queue, Tectonic runner, automatic Tectonic installer, diagnostics |
| `src/project.ts` | Finding the main file and output paths |
| `src/viewer.ts`, `src/webview/` | PDF tab and the PDF.js page inside it (outline, search, hyperlinks, citation tooltips) |
| `src/synctex.ts`, `src/reveal.ts` | SyncTeX lookups and exact-word matching |
| `src/editing.ts`, `src/latex.ts`, `src/bib.ts` | Completion, outline, word count, insert commands |
| `src/citationService.ts`, `src/citations.ts`, `src/citationFinder.ts`, `src/citationFinderPanel.ts` | Citation notes, status watcher, claim-support finder side panel, and built-in bridge runner |
| `src/researchAssistant.ts`, `src/researchAssistantConfig.ts` | Setup wizard, CLI/MCP & plugin registration, warm daemon, Zotero sync, Web UI launcher |
| `research-assistant/` | Bundled Research Assistant Python package (`ra` CLI, `notes.py`, opt-in MCP, Zotero sync, Web UI, stdlib `citation_status.py`) |
| `agent-plugin/` | Bundled `citation-evidence` skill & `AGENTS.md` rules |
| `test/` | Unit tests and the end-to-end suite |

The build uses PDF.js's legacy bundle on purpose: the modern one needs browser features missing from the Chromium in older VS Code versions.

## License

[MIT](LICENSE). The extension bundles [PDF.js](https://github.com/mozilla/pdf.js) (Apache-2.0) and the Research Assistant Python package. [Tectonic](https://github.com/tectonic-typesetting/tectonic) (MIT) and [Zotero](https://www.zotero.org/) (AGPL-3.0) are installed separately.

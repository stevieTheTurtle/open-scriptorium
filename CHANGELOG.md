# Changelog

All notable changes to **Open Scriptorium** are documented in this file.

## [0.5.6] - 2026-11-27

### Fixed
- **Zotero sync no longer crashes when Zotero renames a freshly imported PDF mid-sync.** Zotero imports a PDF under its original name and renames it seconds later after retrieving metadata; a sync started by the storage watcher could hit the old name, raise `FileNotFoundError`, and stop, leaving the remaining new papers unindexed. `zotero_sync.py` now skips such attachments as *pending* (not recorded, so they are retried) and reports `RETRY_PENDING <n>`; Open Scriptorium then re-syncs after 20 s (up to 3 times in a row) so every new paper is picked up without waiting for the next library change.

## [0.5.5] - 2026-11-27

### Added
- **Instant Zotero pickup** (`openScriptorium.researchAssistant.zoteroWatch`, default on): a 1 s file-time check on Zotero's `storage/` folder triggers an incremental sync a few seconds after new PDFs are added. No database reads, no Python and no Zotero plugin while idle; changes that arrive during a sync trigger a follow-up sync. Metadata-only edits are still handled by the periodic sync.
- **Install Citation Rules in Workspace** now also writes the always-on citation rules into the root `AGENTS.md` (marked block, rest of the file preserved) and adds an `@AGENTS.md` import to the root `CLAUDE.md`, so Codex, Cursor, Copilot, Gemini and Claude Code all follow the same project-scoped rules.

### Changed
- Sharpened the `citation-evidence` skill description (Agent Skills format) so agents load it whenever a `.tex`/`.bib` citation is added, changed or checked, and so the evidence rule travels with the skill itself.

## [0.5.4] - 2026-11-27

### Fixed
- Replaced the retired Shields.io `visual-studio-marketplace` badge in `README.md` with the Marketplace-approved dynamic `vsmarketplacebadges.dev` version badge.

## [0.5.3] - 2026-11-27

### Fixed
- Replaced relative HTML `<a href>` links in `README.md` (header navigation links and MIT license badge) with absolute GitHub URLs so every link works on VS Code Marketplace, Open VSX, and inside IDE Extension views (where `vsce` only rewrites Markdown-syntax links).

## [0.5.2] - 2026-11-27

### Changed
- Upgraded the default local CrossEncoder reranker (`openScriptorium.researchAssistant.rerankerModel`) from `cross-encoder/ms-marco-MiniLM-L-6-v2` to **`BAAI/bge-reranker-base`** for stronger academic claim-support and `ra search --rerank` accuracy.
- Added animated loading feedback to the **Citation Finder — Zotero** panel: indeterminate progress bar, spinner, live elapsed timer, progressive stage hints (including first-run model download/warm-up guidance), pulsing skeleton cards, and a `Cancel` action.

### Fixed
- Fixed pair ordering for opt-in NLI CrossEncoder models (such as `cross-encoder/nli-deberta-v3-small`) in `core/claim_support.py` so they receive `(premise=passage, hypothesis=claim)` instead of `(claim, passage)`.
- Increased the warm daemon HTTP timeout for `/api/citations/find-support` to 5 minutes so first-run CrossEncoder downloads complete reliably on slower connections.

## [0.5.1] - 2026-11-27

### Changed
- Restored the **Citation Verification & Claim Search** showcase (with the `citation-states.png` visual, verification states breakdown, and `Ctrl+Alt+C` / `ra` claim-search workflow) directly to `README.md` across GitHub, VS Code Marketplace, and Open VSX.

## [0.5.0] - 2026-11-27

### Added
- **Agent-parametrizable search & pushdown filters** across `ra search`, `ra find-support`, the warm HTTP API (`/api/search`, `/api/search/context`, `/api/citations/find-support`), and the MCP server (`search_papers`, `find_supporting_citations`): filter by `--citekey`/`--key`, `--paper-id` (full ID or prefix), `--tag` (including Zotero `coll:` folder prefixes matching nested subcollections), `--author`, `--year`, `--year-from`, and `--year-to`.
- **Configurable retrieval controls**: choose `--mode hybrid|semantic|bm25`, override `--semantic-weight`, `--bm25-weight`, `--rrf-k`, and `--recall-k`, and enable opt-in local Cross-Encoder reranking (`--rerank`, `--reranker-model`) directly on `ra search`.
- **Verbatim page/chunk reader**: new `ra chunks <paper_id|@citekey> [--page N | --page-from N --page-to M]` command, `GET /api/papers/{id}/chunks` endpoint, and `get_paper_chunks` MCP tool; `ra detail` now also resolves `@citekey` and 6+ char ID prefixes.
- **Pushdown filter execution & capability negotiation**: filters are pushed directly into SQLite FTS5 (`IN` / temp-table joins) and ChromaDB (`where` clauses with safe `n_results` clamping) so narrow/single-paper searches never starve, and `/api/health` advertises capabilities (`search_filters_v1`, `paper_chunks_v1`) so the CLI safely falls back to in-process execution against older running daemons.

## [0.4.2] - 2026-11-27

### Changed
- Simplified `README.md`, hero banner, and diagrams to keep the landing page clean and focused, moving detailed reference tables and developer docs to `docs/REFERENCE.md` and `docs/DEVELOPMENT.md`.
- Aligned VS Code Marketplace, Open VSX, and GitHub descriptions and keywords around Open Scriptorium's core identity as a FOSS academic writing studio for AI agents, Zotero, and local LaTeX.
- Established `dev` / `dev/<feature>` branching workflow with CI checks while reserving `main` for releases.

## [0.4.1] - 2026-11-27

### Added
- Published **Open Scriptorium** (`stevieTheTurtle.open-scriptorium`) to the **Open VSX Registry** alongside the VS Code Marketplace for automatic updates in Antigravity IDE, Cursor, and VSCodium.
- Bundled Mozilla's Apache-2.0 `LICENSE` file for `pdfjs-dist` into `dist/pdfjs/LICENSE` inside the `.vsix` package.

## [0.4.0] - 2026-11-26

### Added
- **Find Supporting Citation in Zotero (`Ctrl+Alt+C`)**: select text in either a `.tex` editor (right-click context menu / shortcut / auto-sentence at cursor) or the PDF preview tab (floating `"Find Citation"` pill / right-click context menu / shortcut with SyncTeX `.tex` anchor resolution) to search your local Zotero index for supporting claims.
- **Local zero-LLM claim-support pipeline (`core/claim_support.py`, `POST /api/citations/find-support`, `ra find-support`)**: strips LaTeX/PDF artifacts, runs weighted RRF hybrid recall (ChromaDB semantic + sanitized OR-based FTS5 BM25), reranks with a local cached `sentence-transformers` `CrossEncoder` (supporting both MS-MARCO/BGE and 3-class NLI entailment models, with offline lexical fallback), and extracts 1–2 verbatim supporting sentences with page numbers.
- **Citation Finder side panel (`CitationFinderPanel`)**: editable claim query, citation command picker (`\cite`, `\citep`, `\citet`, `\parencite`, `\textcite`, `\autocite`), `.bib` fallback key matching, inline quote editing, and one-click `Insert \cite{key} & Save Note` (merges cleanly into adjacent `\cite{...}` and appends to `references.notes.json`).
- New settings: `openScriptorium.citations.citeCommand` and `openScriptorium.researchAssistant.rerankerModel`.

## [0.3.1] - 2026-11-26

### Changed
- Refreshed `README.md` and `SETUP.md` to reflect the CLI-first Research Assistant (`ra` CLI + warm local daemon + opt-in `mcpFallback`), PDF viewer outline/search/hyperlink navigation, complete settings reference, and Marketplace badges.
- Updated extension package metadata (`author`, `description`, `categories`, `keywords`, burgundy `galleryBanner`) and GitHub repository metadata.

### Fixed
- Removed a stray UTF-8 BOM from `.vscodeignore` so packaging rules match `.git/**` cleanly.

## [0.3.0] - 2026-11-25

### Added
- **Automatic Tectonic installation on first use**: when `openScriptorium.tectonicPath` is empty and `tectonic` is not on `PATH`, Open Scriptorium automatically downloads, extracts, and verifies the latest prebuilt Tectonic binary for Windows, macOS, or Linux into `~/.open-scriptorium/bin/`.
- **`Open Scriptorium: Install / Update Tectonic`** command and `openScriptorium.tectonic.autoInstall` setting.
- **GitHub Actions CI and release pipeline** to package `.vsix` artifacts and publish automatically to the VS Code Marketplace and Open VSX Registry on version tags (`v*`).

### Changed
- Updated Marketplace / Open VSX publisher ID to `stevieTheTurtle` (`stevieTheTurtle.open-scriptorium`).

## [0.2.0] - 2026-11-24

### Added
- CLI-first Research Assistant integration (`ra` launcher + warm local HTTP daemon) with opt-in MCP fallback (`openScriptorium.researchAssistant.mcpFallback`).
- PDF viewer upgrades including compile status indicators, auto-compile toggle button, and improved citation evidence tooltips.
- Redesigned Open Scriptorium icon, banner, and documentation diagrams.

### Fixed
- Windows OneDrive reparse-point detection when auto-discovering synced Zotero and Research Assistant data folders.
- Web UI launcher startup reliability.

## [0.1.0] - 2026-11-23

### Added
- Initial release of Open Scriptorium: Tectonic LaTeX compilation, offline PDF.js preview, two-way TypeScript SyncTeX, completion/outline/word count, bundled Research Assistant (Zotero sync, hybrid FTS5 + ChromaDB search, Web UI, MCP server), and PDF citation verification markers.

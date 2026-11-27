<p align="center">
  <img src="assets/banner.png" alt="Open Scriptorium — FOSS academic writing studio for AI agents, Zotero &amp; LaTeX" width="100%" />
</p>

<p align="center">
  <a href="https://marketplace.visualstudio.com/items?itemName=stevieTheTurtle.open-scriptorium"><img src="https://vsmarketplacebadges.dev/version-short/stevieTheTurtle.open-scriptorium.svg?label=VS%20Code&amp;color=2B4666" alt="VS Code Marketplace" /></a>
  <a href="https://open-vsx.org/extension/stevieTheTurtle/open-scriptorium"><img src="https://img.shields.io/open-vsx/v/stevieTheTurtle/open-scriptorium?label=Open%20VSX&color=2E5A44" alt="Open VSX" /></a>
  <a href="https://github.com/stevieTheTurtle/open-scriptorium/releases/latest"><img src="https://img.shields.io/github/v/release/stevieTheTurtle/open-scriptorium?label=Release&color=8B2635" alt="Latest Release" /></a>
  <a href="https://github.com/stevieTheTurtle/open-scriptorium/blob/main/LICENSE"><img src="https://img.shields.io/github/license/stevieTheTurtle/open-scriptorium?color=9A6B1E" alt="MIT License" /></a>
</p>

<p align="center">
  <strong>FOSS academic research &amp; writing studio uniting your AI agent, Zotero library, and local LaTeX workflow in one extension.</strong><br/>
  For VS Code &amp; Antigravity IDE · 100% local · Zero telemetry
</p>

<p align="center">
  <a href="https://github.com/stevieTheTurtle/open-scriptorium#quick-start">Quick Start</a> ·
  <a href="https://github.com/stevieTheTurtle/open-scriptorium/blob/main/SETUP.md">Setup Guide</a> ·
  <a href="https://github.com/stevieTheTurtle/open-scriptorium/blob/main/docs/REFERENCE.md">Settings &amp; Shortcuts</a> ·
  <a href="https://github.com/stevieTheTurtle/open-scriptorium/blob/main/docs/DEVELOPMENT.md">Development</a>
</p>

---

## Everything in One Studio

- **Built for AI-assisted research** — Connects Antigravity, Claude Code, and VS Code directly to your papers via a fast local `ra` CLI, opt-in [MCP](https://modelcontextprotocol.io/) server, and citation-evidence rules so agents never hallucinate references.
- **Zotero-grounded citations** — Syncs your [Zotero](https://www.zotero.org/) PDFs read-only and verifies every citation in the PDF (verified with verbatim quote + page tooltips, second-hand, or unverified).
- **Find supporting citations (`Ctrl+Alt+C`)** — Highlight any claim to search and locally rerank your library, then insert `\cite{...}` with verbatim evidence in one click.
- **Bundled local LaTeX studio** — Auto-installs [Tectonic](https://tectonic-typesetting.github.io/) on first compile, with Problems-panel diagnostics, `\cite`/`\ref` completion, and flicker-free rebuilds.
- **Native PDF preview & exact-word SyncTeX** — Offline PDF.js tab with outline, in-PDF search (`Ctrl+F`), `Ctrl+Click` hyperlinks, and two-way source jump.
- **Private by design** — Your PDFs, vector index, and Zotero sync stay local; Tectonic always runs with `--untrusted`.

## Citation Verification & Claim Search

<p align="center">
  <img src="assets/citation-states.png" alt="PDF citation verification states: Verified, Second-hand, Unverified" width="100%" />
</p>

Every `\cite{...}` in your PDF preview is checked automatically against your local Zotero index and `references.notes.json`:

- **Verified** — Matched to an indexed PDF in Zotero; hovering reveals bibliographic metadata alongside the verbatim supporting quote and exact page number.
- **Second-hand (amber)** — Not yet in your Zotero library, but cited by other indexed papers; hovering lists the citing papers and extracted citing phrases.
- **Unverified (crimson)** — Not indexed and unmentioned across your library; clears automatically once added to Zotero and synced.

**Find Supporting Citation in Zotero (`Ctrl+Alt+C`)** — Select any claim in a `.tex` file or the PDF preview (or click the floating **Find Citation** pill) to run a 100% local, zero-LLM pipeline: cleans LaTeX/PDF artifacts, runs hybrid recall (ChromaDB semantic + SQLite FTS5 BM25), reranks with a local Cross-Encoder, and extracts 1–2 verbatim supporting sentences with page numbers for one-click `\cite{key}` insertion and automatic evidence logging. AI agents can drive the same index via `ra search`, `ra find-support`, and `ra chunks` with pushdown filters (`--citekey`, `--tag`, `--author`, `--year-from`/`--year-to`), `--mode hybrid|semantic|bm25`, and opt-in `--rerank`.

## Quick Start

1. **Install** from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=stevieTheTurtle.open-scriptorium), [Open VSX](https://open-vsx.org/extension/stevieTheTurtle/open-scriptorium), or [GitHub Releases](https://github.com/stevieTheTurtle/open-scriptorium/releases):
   ```bash
   code --install-extension stevieTheTurtle.open-scriptorium
   ```
2. **Compile & preview** — Open any `.tex` file and press `Ctrl+Enter` (`Cmd+Enter` on macOS). Tectonic installs automatically on first use.
3. **Connect Zotero & AI agents** *(optional, Python 3.10+)* — Run **`Open Scriptorium: Research Assistant: Set Up / Configure`** from the Command Palette.

## Essential Shortcuts

| Shortcut | Action |
|---|---|
| `Ctrl+Enter` | Compile & open PDF preview |
| `Ctrl+Alt+Right` / `Left` | SyncTeX jump *(or double-click a word in the PDF)* |
| `Ctrl+Alt+C` | Find supporting citation in Zotero |
| `Ctrl+F` | Search inside PDF |

*On macOS, use `Cmd` instead of `Ctrl`. See [docs/REFERENCE.md](docs/REFERENCE.md) for all shortcuts and settings.*

## Documentation

- **[SETUP.md](SETUP.md)** — Complete setup for users & AI agents, Zotero sync, shared multi-PC indexes, and troubleshooting.
- **[docs/REFERENCE.md](docs/REFERENCE.md)** — Full settings table, shortcuts, citation verification states, and `ra` CLI commands.
- **[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)** — Architecture diagram, build & E2E tests, repository map, security, and roadmap.
- **[CHANGELOG.md](CHANGELOG.md)** — Release history.

## License

[MIT](LICENSE) · Bundles [PDF.js](https://github.com/mozilla/pdf.js) (Apache-2.0); integrates with [Tectonic](https://tectonic-typesetting.github.io/) (MIT) and [Zotero](https://www.zotero.org/) (AGPL-3.0).

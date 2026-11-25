# Changelog

All notable changes to **Open Scriptorium** are documented in this file.

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

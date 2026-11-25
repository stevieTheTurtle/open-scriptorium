# Open Scriptorium — Research Assistant & Citation Evidence Rules

When writing/editing LaTeX with citations or answering literature questions:

1. **Follow the `citation-evidence` skill** and use the `ra` CLI (or `research-assistant` MCP if enabled as fallback) to retrieve papers from the local library before citing. Never invent quotes or BibTeX fields from memory.
2. **Every new `\cite{...}` requires a verbatim evidence note** in the same edit: run `ra notes add --key <key> --quote "<verbatim>" --page <N> --file "<rel.tex>" --claim "<claim>" --paper-id "<id>"` (or append to `references.notes.json`). Copy quotes verbatim (fixing only PDF line-break hyphens/ligatures).
3. **Keep local library (`ra search`) and online arXiv (`ra arxiv search`) separate**: only query arXiv when explicitly asked.

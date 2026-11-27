---
name: citation-evidence
description: >-
  Search the local Research Assistant paper library via the low-token `ra` CLI
  (with optional MCP fallback) and maintain verbatim citation evidence notes in
  references.notes.json whenever adding or verifying LaTeX citations (\cite,
  \citep, \citet). Use whenever writing or editing LaTeX prose with citations,
  answering literature questions from the user's library, or auditing unverified
  (yellow/red) citations in Open Scriptorium.
---

# Citation Evidence & Research Assistant Workflow (CLI-First)

You have access to the user's local paper knowledge base and citation evidence
helpers via the **`ra` CLI** (`{{RA_CLI_CMD}}`). When Open Scriptorium's warm
daemon is running, `ra` responds in ~50 ms; otherwise it falls back cleanly to
direct local execution.

*(Fallback: if shell access is unavailable and the user enabled `openScriptorium.researchAssistant.mcpFallback`, equivalent tools are exposed via the `research-assistant` MCP server.)*

## CLI Commands

Use `--compact` / `--top-k` to keep outputs tight and save tokens.

### Local Paper Library
- `{{RA_CLI_CMD}} search "<query>" -k 5 --compact` — Compact hybrid semantic + BM25 search returning `@citekey`, `Paper ID`, and `[p.N]` verbatim excerpts.
- `{{RA_CLI_CMD}} search "<query>" -k 8 --context` — Full `[Ref N]` + `--- REFERENCES BLOCK ---` format for answering literature questions directly in chat.
  - **Pushdown filters** (pushed directly into ChromaDB & SQLite FTS5 before ranking): `--citekey <key>` (repeatable or CSV, with/without `@`), `--paper-id <id_or_prefix>`, `--tag <tag_or_coll:Folder>` (repeatable; parent `coll:` matches subcollections), `--author <substr>`, `--year <YYYY>`, `--year-from <YYYY>`, `--year-to <YYYY>`.
  - **Retrieval knobs**: `--mode hybrid|semantic|bm25` (use `bm25` for exact acronyms/symbols/author terms, `semantic` for paraphrases), `--semantic-weight <float>`, `--bm25-weight <float>`, `--rrf-k <int>`, `--recall-k <int>`, `--rerank` (local CrossEncoder reranking for higher precision), `--max-chunks <N>`, `--max-chars <N>`.
- `{{RA_CLI_CMD}} find-support "<claim>" -k 8` — Hybrid recall + local CrossEncoder reranker + sentence-level verbatim quote extractor (supports the same `--citekey`, `--tag`, `--author`, `--year*`, `--mode`, `--recall-k`, and `--no-rerank` flags). Ideal for matching a specific LaTeX claim to 1–2 exact supporting sentences.
- `{{RA_CLI_CMD}} chunks <paper_id|@citekey> [--page N | --page-from N --page-to M]` — Read full verbatim indexed chunks for specific pages of a known paper (useful when a search excerpt is truncated or crosses a chunk boundary).
- `{{RA_CLI_CMD}} detail <paper_id|@citekey>` — Full paper metadata & abstract.
- `{{RA_CLI_CMD}} list [--tag <tag>] [--year <YYYY>] --compact` — Browse indexed papers.
- `{{RA_CLI_CMD}} add <pdf_path> [--tags "a,b"]` — Index a local PDF.
- `{{RA_CLI_CMD}} status` — Paper/chunk counts and daemon health.

### Citation Evidence & BibTeX Helpers (Instant — No Need to Read Full JSON/.bib!)
- `{{RA_CLI_CMD}} notes add --key <citekey> --quote "<1-2 verbatim sentences>" --page <N> --file "<rel.tex>" --claim "<supported phrase>" --paper-id "<id>"`
  - Auto-discovers `openScriptorium.citations.notesFile` from `.vscode/settings.json` (or `<bib>.notes.json`), appends safely without overwriting existing notes, and keeps JSON valid.
- `{{RA_CLI_CMD}} notes get <citekey>` — Inspect existing notes for one citekey.
- `{{RA_CLI_CMD}} notes audit` — Cross-check `.bib`, `references.notes.json`, and `citation_status.json` (lists indexed keys missing notes, yellow second-hand keys, and red unsourced keys).
- `{{RA_CLI_CMD}} bib get <citekey>` — Print a single BibTeX entry without loading the entire `.bib` file.

### Online arXiv Discovery (Only When Explicitly Requested)
- `{{RA_CLI_CMD}} arxiv search "<query>" -n 10`
- `{{RA_CLI_CMD}} arxiv fetch <arxiv_id> [--add --tags "..."]`

## Mandatory Rule: Every New LaTeX Citation Needs Verbatim Evidence

Whenever you add a `\cite{key}` (`\citep`, `\citet`, `\citealp`, etc.) to any
`.tex` file, in the **same turn**, record a verbatim evidence note with
`{{RA_CLI_CMD}} notes add ...` (targeting `openScriptorium.citations.notesFile`,
e.g. `01_Thesis_meta/references.notes.json`):

```json
{
  "citekey": [
    {
      "quote": "<1-2 sentences copied VERBATIM from the cited paper that support the claim>",
      "page": 12,
      "file": "chapters/02_background/02_background.tex",
      "claim": "<the prose phrase the citation supports>",
      "paper_id": "<research-assistant Paper ID>",
      "added": "YYYY-MM-DD"
    }
  ]
}
```

### Strict Guidelines

1. **Retrieve first**: Run `{{RA_CLI_CMD}} search "<query>" -k 5 --compact` before citing. Match the `@citekey` tag and use `[p.N]` as `--page`.
2. **Copy quotes verbatim**: Never paraphrase, summarize, or invent a quote. Only repair obvious PDF extraction artefacts (line-break hyphens like `inter-\naction` -> `interaction`, or broken ligatures such as `ﬁ` -> `fi`).
3. **Support the specific claim**: Choose a passage that actually supports the claim being made, not merely the paper's general topic. If the closest passage only loosely supports the claim, tell the user explicitly.
4. **Append, do not overwrite**: Always use `ra notes add` (or append to the key's JSON array while preserving `_`-prefixed comment keys).
5. **BibTeX entries from Zotero / verified sources only**: Never fabricate BibTeX fields from memory. If a paper is missing from the library / Zotero, leave it out and inform the user.
6. **Unindexed or garbled PDFs**: If a cited paper is not in the Research Assistant index (yellow/red in the PDF viewer) or its extracted text is garbled (scanned PDF, poster), do not invent a note; list those citekeys in your reply for manual verification.

## Answering General Research Questions (Non-LaTeX)

When answering literature questions directly in chat using `{{RA_CLI_CMD}} search "<query>" --context`:
- Cite every claim inline as `[Ref N]` matching the evidence block number.
- Copy the `--- REFERENCES BLOCK ---` verbatim under `## References` at the end of your answer.
- Clearly distinguish local library results (`ra search`) from online arXiv results (`ra arxiv search`).

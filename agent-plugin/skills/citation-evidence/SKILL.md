---
name: citation-evidence
description: >-
  Search the local Research Assistant paper library via MCP and maintain
  verbatim citation evidence notes in references.notes.json whenever adding or
  verifying LaTeX citations (\cite, \citep, \citet). Use whenever writing or
  editing LaTeX prose with citations, answering literature questions from the
  user's library, or auditing unverified (yellow/red) citations in Open LaTeX
  Studio.
---

# Citation Evidence & Research Assistant Workflow

You have access to the user's local paper knowledge base via the
`research-assistant` MCP server, paired with **Open LaTeX Studio**'s citation
evidence system.

## Tools (`research-assistant` MCP)

- `search_papers(query, top_k=8)` — Hybrid semantic + keyword search over the
  user's local paper library. Results include `@citekey` tags, `Paper ID`, and
  page-numbered chunks `[p.N]`.
- `get_paper_detail(paper_id)` — Full metadata for a paper.
- `list_all_papers(tag="", year=0)` — Browse papers in the library.
- `add_paper(pdf_path, tags="")` — Index a local PDF.
- `search_arxiv_papers(query, max_results=10)` / `fetch_arxiv_paper(...)` —
  Online arXiv discovery (only when explicitly requested by the user and enabled
  in Research Assistant).

## Mandatory Rule: Every New LaTeX Citation Needs Verbatim Evidence

Whenever you add a `\cite{key}` (`\citep`, `\citet`, `\citealp`, etc.) to any
`.tex` file, in the **same edit** as the `.tex`/`.bib` change, append an entry
for `key` to the project's citation notes file (configured by
`openLatexStudio.citations.notesFile`, e.g. `01_Thesis_meta/references.notes.json`,
or a sibling `<bib>.notes.json` next to the `.bib` file):

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

1. **Retrieve first**: Call `search_papers` before citing. Match the `@citekey`
   tag returned in the paper's tags and use the chunk's `[p.N]` as `"page"`.
2. **Copy quotes verbatim**: Never paraphrase, summarize, or invent a quote.
   Only repair obvious PDF extraction artefacts (line-break hyphens like
   `inter-\naction` -> `interaction`, or broken ligatures such as `ﬁ` -> `fi`).
3. **Support the specific claim**: Choose a passage that actually supports the
   claim being made, not merely the general topic of the paper. If the closest
   passage only loosely supports the claim, tell the user explicitly.
4. **Append, do not overwrite**: Each bib key maps to a JSON array of notes.
   Append to the existing list and keep the JSON valid. Keys starting with `_`
   are reserved for comments.
5. **BibTeX entries from Zotero / verified sources only**: Never fabricate
   BibTeX fields (authors, venues, years, DOIs, page numbers) from memory. If a
   paper is missing from the library / Zotero, leave it out and inform the user.
6. **Unindexed or garbled PDFs**: If a cited paper is not in the Research
   Assistant index (highlighted yellow or red in the Open LaTeX Studio PDF
   viewer) or its extracted text is garbled (scanned PDF, poster), do not invent
   a note; list those citekeys in your reply so the user can check them manually.

## Answering General Research Questions (Non-LaTeX)

When answering literature questions directly in chat using `search_papers`:
- Cite every claim inline as `[Ref N]` matching the evidence block number.
- Copy the `--- REFERENCES BLOCK ---` verbatim under `## References` at the end
  of your answer.
- Clearly distinguish local library results (`search_papers`) from online arXiv
  results (`search_arxiv_papers`).

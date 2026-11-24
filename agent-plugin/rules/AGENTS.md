# Open LaTeX Studio — Research Assistant & Citation Evidence Rules

When working on LaTeX documents or answering literature questions in a workspace
using Open LaTeX Studio and the `research-assistant` MCP server:

1. **Always verify claims against the local library** using `search_papers`
   before citing papers or quoting findings. Never invent quotes or BibTeX
   entries from memory.
2. **Every new `\cite{...}` requires a verbatim evidence note**: In the same
   edit as adding a citation to a `.tex` file, append an evidence note
   (`quote`, `page`, `file`, `claim`, `paper_id`, `added`) to the project's
   citation notes JSON file (`openLatexStudio.citations.notesFile` or sibling
   `<bib>.notes.json`). Follow the `citation-evidence` skill for the exact
   schema and handling of unindexed/garbled PDFs.
3. **Copy quotes verbatim** from retrieved chunks (fixing only PDF line-break
   hyphens and broken ligatures). Never paraphrase or fabricate a quote.
4. **Keep local KB and arXiv separate**: Use `search_papers` for the user's own
   library and `search_arxiv_papers` only when explicitly asked to search online.

// Small LaTeX source readers. No editor dependencies, so they can be tested on their own.

import * as path from 'node:path';

const COMMENT = /(?<!\\)%.*/g;

export function stripComments(text: string): string {
  return text.replace(COMMENT, '');
}

// ---- Headings -------------------------------------------------------------------------------

export const HEADING_LEVELS = ['part', 'chapter', 'section', 'subsection', 'subsubsection', 'paragraph'];
const HEADING = /\\(part|chapter|section|subsection|subsubsection|paragraph)\*?\s*(?:\[[^\]]*\])?\s*\{/;

export interface Heading {
  /** Index into HEADING_LEVELS: smaller is higher in the hierarchy. */
  level: number;
  title: string;
  line: number;
  start: number;
  end: number;
}

function cleanTitle(title: string): string {
  return title
    .replace(/\\[a-zA-Z]+\*?\s*/g, '')
    .replace(/[{}]/g, '')
    .replace(/~/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function parseHeadings(text: string): Heading[] {
  const headings: Heading[] = [];
  text.split(/\r?\n/).forEach((raw, line) => {
    const code = stripComments(raw);
    const match = HEADING.exec(code);
    if (!match) return;
    const open = match.index + match[0].length;
    let depth = 1;
    let end = open;
    while (end < code.length && depth > 0) {
      if (code[end] === '{' && code[end - 1] !== '\\') depth++;
      else if (code[end] === '}' && code[end - 1] !== '\\') depth--;
      end++;
    }
    const titleEnd = depth === 0 ? end - 1 : code.length;
    headings.push({
      level: HEADING_LEVELS.indexOf(match[1]),
      title: cleanTitle(code.slice(open, titleEnd)) || match[1],
      line,
      start: match.index,
      end,
    });
  });
  return headings;
}

// ---- Labels ---------------------------------------------------------------------------------

export function parseLabels(text: string): { label: string; line: number }[] {
  const labels: { label: string; line: number }[] = [];
  text.split(/\r?\n/).forEach((raw, line) => {
    for (const match of stripComments(raw).matchAll(/\\label\{([^}]+)\}/g)) labels.push({ label: match[1].trim(), line });
  });
  return labels;
}

// ---- Completion context ---------------------------------------------------------------------

export type CompletionKind = 'cite' | 'ref' | 'env';

export interface CompletionContext {
  kind: CompletionKind;
  /** What has been typed of the current key. */
  prefix: string;
  /** Column where that key starts. */
  column: number;
}

const CITE_CONTEXT = /\\[a-zA-Z]*cite[a-zA-Z]*\*?(?:\[[^\]]*\])*\{([^}]*)$/i;
const REF_CONTEXT = /\\(?:ref|eqref|cref|Cref|autoref|pageref|nameref|vref)\*?\{([^}]*)$/;
const ENV_CONTEXT = /\\(?:begin|end)\{([^}]*)$/;

export function completionContext(before: string): CompletionContext | null {
  const contexts: [CompletionKind, RegExp][] = [
    ['cite', CITE_CONTEXT],
    ['ref', REF_CONTEXT],
    ['env', ENV_CONTEXT],
  ];
  for (const [kind, pattern] of contexts) {
    const match = pattern.exec(before);
    if (!match) continue;
    const prefix = match[1].slice(match[1].lastIndexOf(',') + 1).trimStart();
    return { kind, prefix, column: before.length - prefix.length };
  }
  return null;
}

// ---- Word count -----------------------------------------------------------------------------

export interface TextStats {
  words: number;
  headings: number;
  math: number;
}

const NON_PROSE_COMMAND =
  /\\(?:[a-zA-Z]*cite[a-zA-Z]*|ref|eqref|cref|Cref|autoref|pageref|nameref|vref|label|input|include|subfile|includegraphics|bibliography|bibliographystyle|usepackage|documentclass|begin|end|url|newcommand|renewcommand|setlength|setcounter|hypersetup|vspace|hspace)\*?(?:\[[^\]]*\])*(?:\{[^{}]*\})*/g;
const INLINE_MATH = /\$[^$]+\$/g;
const DISPLAY_MATH = /\\\[[\s\S]*?\\\]|\\begin\{(equation|align|gather|multline|eqnarray)(\*?)\}[\s\S]*?\\end\{\1\2\}/g;
const WORD = /[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu;

/** Counts the prose of a .tex file: command arguments that are text count, math and references do not. */
export function textStats(source: string): TextStats {
  let text = stripComments(source);
  const begin = text.indexOf('\\begin{document}');
  if (begin >= 0) {
    text = text.slice(begin + '\\begin{document}'.length);
    const end = text.indexOf('\\end{document}');
    if (end >= 0) text = text.slice(0, end);
  }

  const headings = (text.match(/\\(?:chapter|section|subsection|subsubsection)\*?\s*(?:\[[^\]]*\])?\s*\{/g) ?? []).length;
  const display = text.match(DISPLAY_MATH)?.length ?? 0;
  const withoutDisplay = text.replace(DISPLAY_MATH, ' ');
  const inline = withoutDisplay.match(INLINE_MATH)?.length ?? 0;
  const prose = withoutDisplay
    .replace(INLINE_MATH, ' ')
    .replace(NON_PROSE_COMMAND, ' ')
    .replace(/\\[a-zA-Z]+\*?(?:\[[^\]]*\])?/g, ' ');

  return { words: prose.match(WORD)?.length ?? 0, headings, math: display + inline };
}

export interface ProjectFile {
  file: string;
  text: string;
  /** Pulled in before \begin{document}, so it holds settings rather than prose. */
  preamble: boolean;
}

/** The main file and everything it pulls in, in document order. */
export function projectFiles(mainFile: string, read: (file: string) => string | null): ProjectFile[] {
  const root = path.dirname(mainFile);
  const seen = new Set<string>();
  const files: ProjectFile[] = [];

  const visit = (file: string, text: string, preamble: boolean) => {
    seen.add(file);
    files.push({ file, text, preamble });
    const code = stripComments(text);
    const documentStart = code.indexOf('\\begin{document}');
    for (const match of code.matchAll(/\\(?:input|include|subfile)\{([^}]+)\}/g)) {
      const target = path.resolve(root, match[1].trim());
      for (const candidate of [target, `${target}.tex`]) {
        if (seen.has(candidate)) continue;
        const included = read(candidate);
        if (included !== null) {
          visit(candidate, included, preamble || match.index < documentStart);
          break;
        }
      }
    }
  };

  const mainText = read(mainFile);
  if (mainText !== null) visit(mainFile, mainText, false);
  return files;
}

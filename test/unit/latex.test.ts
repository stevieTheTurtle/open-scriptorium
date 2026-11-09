import assert from 'node:assert/strict';
import * as path from 'node:path';
import { test } from 'node:test';
import { detex, parseBib, shortAuthors, venueOf } from '../../src/bib.ts';
import { completionContext, parseHeadings, parseLabels, projectFiles, stripComments, textStats } from '../../src/latex.ts';

test('bib: entries, nested braces, quotes and bare values', () => {
  const entries = parseBib(`
@string{x = "ignored"}
@article{doe2020,
  author = {Doe, Jane and Roe, Richard},
  title = {Believable {A}vatars: a \\emph{study}},
  journal = "Virtual {W}orlds",
  year = 2020,
}
@comment{nothing}
@inproceedings{smith, title={Only title}, booktitle={Proc. X}}`);
  assert.deepEqual([...entries.keys()], ['doe2020', 'smith']);
  const doe = entries.get('doe2020')!;
  assert.equal(doe.type, 'article');
  assert.equal(doe.title, 'Believable Avatars: a study');
  assert.equal(doe.journal, 'Virtual Worlds');
  assert.equal(doe.year, '2020');
  assert.equal(venueOf(entries.get('smith')!), 'Proc. X');
});

test('bib: accents and escapes become plain text', () => {
  assert.equal(detex("Caf\\'e M\\\"uller \\c{c} R\\&D 10\\% 1--2"), 'Café Müller ç R&D 10% 1–2');
});

test('bib: short author forms', () => {
  assert.equal(shortAuthors('Doe, Jane'), 'Doe');
  assert.equal(shortAuthors('Jane Doe and Richard Roe'), 'Doe & Roe');
  assert.equal(shortAuthors('Doe, Jane and Roe, Richard and Poe, Edgar'), 'Doe et al.');
  assert.equal(shortAuthors(undefined), '');
});

test('comments are removed but escaped percent stays', () => {
  assert.equal(stripComments('50\\% done % hidden'), '50\\% done ');
});

test('headings: levels, nested braces, short titles, comments', () => {
  const headings = parseHeadings(['\\chapter{One}', '% \\section{Hidden}', '  \\section[short]{A \\emph{nice} title}', '\\subsection*{Three}'].join('\n'));
  assert.deepEqual(
    headings.map((h) => [h.level, h.title, h.line]),
    [
      [1, 'One', 0],
      [2, 'A nice title', 2],
      [3, 'Three', 3],
    ],
  );
  assert.equal(headings[1].start, 2);
  assert.equal(headings[1].end, '  \\section[short]{A \\emph{nice} title}'.length);
});

test('labels: found with their lines, comments ignored', () => {
  assert.deepEqual(parseLabels('\\label{a}\n% \\label{b}\ntext \\label{fig:c} \\label{d}'), [
    { label: 'a', line: 0 },
    { label: 'fig:c', line: 2 },
    { label: 'd', line: 2 },
  ]);
});

test('completion context: citations, including lists and options', () => {
  assert.deepEqual(completionContext('see \\cite{do'), { kind: 'cite', prefix: 'do', column: 10 });
  assert.deepEqual(completionContext('\\citep[p.~3]{abc, de'), { kind: 'cite', prefix: 'de', column: 18 });
  assert.equal(completionContext('\\textcite{x')?.kind, 'cite');
});

test('completion context: references and environments', () => {
  assert.deepEqual(completionContext('\\ref{fig:a'), { kind: 'ref', prefix: 'fig:a', column: 5 });
  assert.equal(completionContext('\\cref{x')?.kind, 'ref');
  assert.deepEqual(completionContext('\\begin{it'), { kind: 'env', prefix: 'it', column: 7 });
});

test('completion context: nothing outside an open argument', () => {
  assert.equal(completionContext('\\cite{done} and more'), null);
  assert.equal(completionContext('plain text'), null);
  assert.equal(completionContext('\\textbf{x'), null);
});

test('word count: prose in commands counts, references and math do not', () => {
  const source = [
    '\\documentclass{article}',
    '\\usepackage{ignored}',
    '\\begin{document}',
    'Hello \\textbf{bold world} % hidden words',
    '\\cite{abc} and \\ref{x} $a+b$ \\section{Title here}',
    '\\[ x = y \\]',
    '\\end{document}',
    'after the end',
  ].join('\n');
  assert.deepEqual(textStats(source), { words: 6, headings: 1, math: 2 });
});

test('word count: accents, hyphens and apostrophes stay one word', () => {
  assert.equal(textStats("perché well-known it's").words, 3);
});

test('word count: display environments are math', () => {
  assert.deepEqual(textStats('One \\begin{align*} a &= b \\end{align*} two'), { words: 2, headings: 0, math: 1 });
});

test('project files: files included before the document starts are preamble', () => {
  const root = path.resolve('/project');
  const files: Record<string, string> = {
    [path.join(root, 'main.tex')]: '\\input{setup}\n\\begin{document}\n\\input{body}\n\\end{document}',
    [path.join(root, 'setup.tex')]: 'settings',
    [path.join(root, 'body.tex')]: 'prose',
  };
  const result = projectFiles(path.join(root, 'main.tex'), (file) => files[file] ?? null);
  assert.deepEqual(result.map((f) => [path.basename(f.file), f.preamble]), [
    ['main.tex', false],
    ['setup.tex', true],
    ['body.tex', false],
  ]);
});

test('project files: follows includes in order, ignores comments, survives cycles', () => {
  const root = path.resolve('/project');
  const files: Record<string, string> = {
    [path.join(root, 'main.tex')]: '\\input{a}\n% \\input{hidden}\n\\include{chapters/b}',
    [path.join(root, 'a.tex')]: 'A \\input{main}',
    [path.join(root, 'chapters', 'b.tex')]: 'B',
    [path.join(root, 'hidden.tex')]: 'H',
  };
  const result = projectFiles(path.join(root, 'main.tex'), (file) => files[file] ?? null);
  assert.deepEqual(
    result.map((f) => path.relative(root, f.file).split(path.sep).join('/')),
    ['main.tex', 'a.tex', 'chapters/b.tex'],
  );
});

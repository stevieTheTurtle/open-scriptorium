import assert from 'node:assert/strict';
import test from 'node:test';
import { parseBib } from '../../src/bib.ts';
import {
  appendEvidenceNoteJson,
  cleanClaimText,
  computeCiteInsertion,
  extractSentenceAtPosition,
  matchBibKeyForPaper,
} from '../../src/citationFinder.ts';

test('cleanClaimText strips LaTeX macros, citations, comments, and repairs PDF hyphens & ligatures', () => {
  const latex = String.raw`Modern \textbf{sequence \emph{transduction}} models~\citep[p.~2]{vaswani2017} rely on self-attention % draft note
and cross-\ref{sec:method} in efﬁcient ﬂows.`;
  assert.equal(
    cleanClaimText(latex),
    'Modern sequence transduction models rely on self-attention and cross- in efficient flows.',
  );

  const pdfText = 'Human-robot inter-\naction requires cali-\nbrated trust in ﬁeld robotics.';
  assert.equal(
    cleanClaimText(pdfText),
    'Human-robot interaction requires calibrated trust in field robotics.',
  );
});

test('extractSentenceAtPosition grabs the enclosing sentence and ignores comments', () => {
  const line = 'First sentence here. Robots must communicate intent clearly. Third sentence. % ignored.';
  const res = extractSentenceAtPosition(line, 35);
  assert.equal(res.text, 'Robots must communicate intent clearly.');
  assert.equal(line.slice(res.start, res.end), 'Robots must communicate intent clearly.');
});

test('computeCiteInsertion places citation before trailing punctuation and merges into existing \\cite', () => {
  const line1 = 'Transformers rely solely on self-attention.';
  const p1 = computeCiteInsertion(line1, line1.length, 'vaswani2017', '\\citep');
  assert.equal(p1.alreadyPresent, false);
  const out1 = line1.slice(0, p1.replaceStart) + p1.insertText + line1.slice(p1.replaceEnd);
  assert.equal(out1, 'Transformers rely solely on self-attention~\\citep{vaswani2017}.');

  // Inserting a second citation at the end of the same sentence merges cleanly into \citep{...}
  const p2 = computeCiteInsertion(out1, out1.length, 'devlin2019', '\\citep');
  assert.equal(p2.alreadyPresent, false);
  const out2 = out1.slice(0, p2.replaceStart) + p2.insertText + out1.slice(p2.replaceEnd);
  assert.equal(out2, 'Transformers rely solely on self-attention~\\citep{vaswani2017, devlin2019}.');

  // Duplicate key is detected and not inserted twice
  const p3 = computeCiteInsertion(out2, out2.length, 'vaswani2017', '\\citep');
  assert.equal(p3.alreadyPresent, true);
  assert.equal(p3.insertText, '');
});

test('appendEvidenceNoteJson preserves comment keys, appends, and deduplicates', () => {
  const initial = JSON.stringify(
    {
      _comment: 'Evidence notes for thesis',
      vaswani2017: { quote: 'Old quote.', page: 1, file: 'chapters/01.tex' },
    },
    null,
    2,
  );
  const r1 = appendEvidenceNoteJson(initial, 'vaswani2017', {
    quote: 'The Transformer relies entirely on self-attention.',
    page: 2,
    file: 'chapters/02.tex',
    claim: 'Transformers rely on self-attention.',
    paper_id: 'abc123',
    added: '2026-11-26',
  });
  assert.equal(r1.duplicate, false);
  assert.equal(r1.count, 2);
  const parsed = JSON.parse(r1.json);
  assert.equal(parsed._comment, 'Evidence notes for thesis');
  assert.equal(parsed.vaswani2017.length, 2);
  assert.equal(parsed.vaswani2017[1].page, 2);

  // Deduplicates exact (quote, file)
  const r2 = appendEvidenceNoteJson(r1.json, '@vaswani2017', {
    quote: 'The Transformer relies entirely on self-attention.',
    page: 2,
    file: 'chapters\\02.tex',
    added: '2026-11-26',
  });
  assert.equal(r2.duplicate, true);
  assert.equal(r2.count, 2);
});

test('matchBibKeyForPaper matches exact and fuzzy titles with first-author surname', () => {
  const bib = parseBib(`
    @inproceedings{vaswani2017attention,
      title = {Attention Is All You Need},
      author = {Vaswani, Ashish and Shazeer, Noam},
      year = {2017}
    }
    @article{lee2004trust,
      title = {Trust in Automation: Designing for Appropriate Reliance},
      author = {John D. Lee and Katrina A. See},
      year = {2004}
    }
  `);
  assert.equal(matchBibKeyForPaper('Attention is all you need', ['Ashish Vaswani'], bib), 'vaswani2017attention');
  assert.equal(
    matchBibKeyForPaper('Trust in Automation: Designing for Appropriate Reliance in Safety-Critical Systems', ['John D. Lee'], bib),
    'lee2004trust',
  );
  assert.equal(matchBibKeyForPaper('Unrelated Paper Title', ['Someone Else'], bib), null);
});

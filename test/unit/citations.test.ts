import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseBib } from '../../src/bib.ts';
import { mergeCitations, parseNotesFile, parseStatusFile } from '../../src/citations.ts';

test('notes: ignores comment keys, accepts single objects and lists, requires quote', () => {
  const notes = parseNotesFile(
    JSON.stringify({
      _about: 'ignored',
      a: [{ quote: 'Verbatim quote.', page: 12, file: 'chapters/ch1.tex' }, { quote: '' }],
      b: { quote: 'Single note', page: '3-4' },
      c: [{ claim: 'missing quote' }],
    }),
  );
  assert.deepEqual([...notes.keys()], ['a', 'b']);
  assert.deepEqual(notes.get('a'), [{ quote: 'Verbatim quote.', page: 12, file: 'chapters/ch1.tex' }]);
  assert.deepEqual(notes.get('b'), [{ quote: 'Single note', page: '3-4' }]);
});

test('status: parses version 1 citation_status.json and snake_case fallback', () => {
  const status = parseStatusFile(
    JSON.stringify({
      version: 1,
      citations: {
        ok: { indexed: true, citedIn: null, inside: null },
        secondhand: { indexed: false, citedIn: { count: 2, papers: [{ title: 'Paper A', page: 5 }] }, inside: null },
        unsourced: { indexed: false, cited_in: { count: 0, papers: [] } },
        inBook: { indexed: true, citedIn: null, inside: { title: 'Handbook', page: 42 } },
      },
    }),
  );
  assert.equal(status.get('ok')?.indexed, true);
  assert.equal(status.get('secondhand')?.indexed, false);
  assert.equal(status.get('secondhand')?.citedIn?.count, 2);
  assert.equal(status.get('secondhand')?.citedIn?.papers[0].title, 'Paper A');
  assert.equal(status.get('unsourced')?.citedIn?.count, 0);
  assert.deepEqual(status.get('inBook')?.inside, { title: 'Handbook', page: 42 });
});

test('mergeCitations combines bib metadata, notes, and status', () => {
  const bib = parseBib('@article{doe2020, author={Doe, Jane}, title={A Study}, journal={J. Test}, year={2020}}');
  const notes = parseNotesFile(JSON.stringify({ doe2020: [{ quote: 'Exact sentence.', page: 7 }] }));
  const status = parseStatusFile(JSON.stringify({ version: 1, citations: { doe2020: { indexed: false, citedIn: { count: 0, papers: [] } } } }));
  const merged = mergeCitations(bib, notes, status);

  assert.equal(merged.doe2020.title, 'A Study');
  assert.equal(merged.doe2020.shortAuthors, 'Doe');
  assert.equal(merged.doe2020.venue, 'J. Test');
  assert.equal(merged.doe2020.indexed, false);
  assert.equal(merged.doe2020.citedIn?.count, 0);
  assert.equal(merged.doe2020.notes[0].quote, 'Exact sentence.');
});

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { parseCompilerIssues } from '../../src/issues.ts';
import { cleanWord, findWordNear } from '../../src/reveal.ts';
import { SyncTexData } from '../../src/synctex.ts';

// One bp equals 65781.76 sp; with Unit 1 and Magnification 1000 these coordinates are easy to read.
const bp = (n: number) => Math.round(n * 65781.76);

function project(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ols-'));
  fs.writeFileSync(path.join(dir, 'main.tex'), 'first\n\nthird\n');
  fs.mkdirSync(path.join(dir, 'chapters'));
  fs.writeFileSync(path.join(dir, 'chapters', 'one.tex'), 'a\nb\nc\nd\n');
  return dir;
}

function sample(dir: string): SyncTexData {
  const text = [
    'SyncTeX Version:1',
    `Input:1:${path.join(dir, 'main.tex')}`,
    'Input:2:chapters/one.tex',
    'Input:3:',
    'Input:4:/elsewhere/package.sty',
    'Output:pdf',
    'Magnification:1000',
    'Unit:1',
    'X Offset:0',
    'Y Offset:0',
    'Content:',
    '{1',
    `[1,1:${bp(50)},${bp(100)}:${bp(400)},${bp(90)},0`,
    `(2,3:${bp(100)},${bp(100)}:${bp(200)},${bp(10)},${bp(2)}`,
    `x2,3:${bp(100)},${bp(100)}`,
    `x2,4:${bp(200)},${bp(100)}`,
    ')',
    `(1,3:${bp(100)},${bp(130)}:${bp(200)},${bp(10)},${bp(2)}`,
    `x1,2:${bp(100)},${bp(130)}`,
    ')',
    `(3,9:${bp(100)},${bp(160)}:${bp(200)},${bp(10)},${bp(2)}`,
    `x3,9:${bp(100)},${bp(160)}`,
    ')',
    ']',
    '}1',
    '',
  ].join('\n');
  return new SyncTexData(text, dir);
}

test('edit finds the leaf at or before the click', () => {
  const data = sample(project());
  assert.deepEqual(data.edit(1, 150, 98), { file: 'chapters/one.tex', line: 3 });
  assert.deepEqual(data.edit(1, 250, 98), { file: 'chapters/one.tex', line: 4 });
});

test('edit snaps a blank line back to the text before it', () => {
  const data = sample(project());
  assert.deepEqual(data.edit(1, 150, 128), { file: 'main.tex', line: 1 });
});

test('edit never reports files from the TeX bundle', () => {
  const data = sample(project());
  const hit = data.edit(1, 150, 158);
  assert.ok(hit);
  assert.notEqual(hit.file, '.');
  assert.ok(['main.tex', 'chapters/one.tex'].includes(hit.file));
});

test('edit returns null for a page that does not exist', () => {
  assert.equal(sample(project()).edit(9, 1, 1), null);
});

test('view converts to top-left boxes', () => {
  const result = sample(project()).view('chapters/one.tex', 3);
  assert.ok(result);
  assert.equal(result.line, 3);
  assert.equal(result.boxes.length, 1);
  const box = result.boxes[0];
  assert.equal(box.page, 1);
  assert.ok(Math.abs(box.x - 100) < 0.01);
  assert.ok(Math.abs(box.y - 90) < 0.01);
  assert.ok(Math.abs(box.width - 200) < 0.01);
  assert.ok(Math.abs(box.height - 12) < 0.01);
});

test('view prefers the nearest following line, and strips ./', () => {
  const data = sample(project());
  assert.equal(data.view('./chapters/one.tex', 1)?.line, 3);
  assert.equal(data.view('chapters/one.tex', 99)?.line, 4);
  assert.equal(data.view('missing.tex', 1), null);
});

test('issues: located errors, warnings and bad boxes', () => {
  const log = [
    'note: Running TeX ...',
    'warning: chapters/a.tex:135: Overfull \\hbox (4.5pt too wide) in paragraph at lines 134--135',
    'warning: chapters/a.tex:40: Underfull \\hbox (badness 10000) in paragraph',
    'warning: refs.tex:7: Citation undefined',
    'error: chapters\\b.tex:12: Undefined control sequence',
  ].join('\n');
  assert.deepEqual(parseCompilerIssues(log), [
    { type: 'badbox', file: 'chapters/a.tex', line: 135, message: 'Overfull \\hbox (4.5pt too wide) in paragraph at lines 134--135' },
    { type: 'badbox', file: 'chapters/a.tex', line: 40, message: 'Underfull \\hbox (badness 10000) in paragraph' },
    { type: 'warning', file: 'refs.tex', line: 7, message: 'Citation undefined' },
    { type: 'error', file: 'chapters/b.tex', line: 12, message: 'Undefined control sequence' },
  ]);
});

test('issues: classic TeX errors look ahead for the line', () => {
  const issues = parseCompilerIssues('! Missing $ inserted.\n<inserted text>\nl.42 some source\n', 'thesis.tex');
  assert.deepEqual(issues, [{ type: 'error', file: 'thesis.tex', line: 42, message: 'Missing $ inserted.' }]);
});

test('issues: errors without a location use the main file', () => {
  assert.deepEqual(parseCompilerIssues('error: halted on potentially-recoverable error', 'x.tex'), [
    { type: 'error', file: 'x.tex', line: 1, message: 'halted on potentially-recoverable error' },
  ]);
});

test('issues: Tectonic error output reduces to the one real error', () => {
  const log = [
    'error: ch1:8: Undefined control sequence',
    'error: something bad happened inside XeTeX; its output follows:',
    '! Undefined control sequence.',
    'l.8 \\undefinedmacroxyz',
    'error: the XeTeX engine had an unrecoverable error',
  ].join('\n');
  assert.deepEqual(parseCompilerIssues(log), [{ type: 'error', file: 'ch1', line: 8, message: 'Undefined control sequence' }]);
});

test('issues: an engine failure is kept when it is all there is', () => {
  assert.equal(parseCompilerIssues('error: the XeTeX engine had an unrecoverable error', 'x.tex').length, 1);
});

test('cleanWord keeps the first word only', () => {
  assert.equal(cleanWord('  (believability, and'), 'believability');
  assert.equal(cleanWord(''), '');
  assert.equal(cleanWord(null), '');
});

test('findWordNear searches neighbours and uses context', () => {
  const filler = 'x '.repeat(60);
  const lines = ['nothing here', `the avatar moves ${filler}the avatar speaks to users`, 'tail'];
  const hit = findWordNear(lines, 0, 'avatar', 'speaks to users');
  assert.deepEqual(hit, { line: 1, character: 141, length: 6 });
});

test('findWordNear strips a trailing hyphen and does not match inside words', () => {
  assert.deepEqual(findWordNear(['believable'], 0, 'believ-', ''), { line: 0, character: 0, length: 6 });
  assert.equal(findWordNear(['unbelievable'], 0, 'believ', ''), null);
  assert.equal(findWordNear(['text'], 0, '', ''), null);
});

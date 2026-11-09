import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { findOnPath, outputPathsFor, runTectonic } from '../../src/compile.ts';

function outputDir() {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ols-build-'));
  const paths = outputPathsFor(path.join(outDir, 'thesis.tex'), outDir);
  fs.writeFileSync(paths.pdfPath, 'old pdf');
  fs.writeFileSync(paths.synctexPath, 'old synctex');
  const unrelated = path.join(outDir, 'keep-me.txt');
  fs.writeFileSync(unrelated, 'not ours');
  return { outDir, unrelated, ...paths };
}

const request = (o: ReturnType<typeof outputDir>, clean: boolean) => ({
  executable: path.join(o.outDir, 'no-such-compiler.exe'),
  mainFile: path.join(o.outDir, 'thesis.tex'),
  outDir: o.outDir,
  pdfPath: o.pdfPath,
  synctexPath: o.synctexPath,
  clean,
});

test('output paths follow the main file name', () => {
  const paths = outputPathsFor(path.join('a', 'thesis.tex'), 'out');
  assert.equal(paths.pdfPath, path.join('out', 'thesis.pdf'));
  assert.equal(paths.synctexPath, path.join('out', 'thesis.synctex.gz'));
});

test('a clean build deletes only its own outputs', async () => {
  const o = outputDir();
  await runTectonic(request(o, true));
  assert.equal(fs.existsSync(o.pdfPath), false);
  assert.equal(fs.existsSync(o.synctexPath), false);
  assert.equal(fs.existsSync(o.unrelated), true);
});

test('a normal build leaves previous outputs alone', async () => {
  const o = outputDir();
  await runTectonic(request(o, false));
  assert.equal(fs.existsSync(o.pdfPath), true);
});

test('a compiler that cannot start is an error, even with a leftover PDF', async () => {
  const result = await runTectonic(request(outputDir(), false));
  assert.equal(result.success, false);
  assert.ok(result.error);
});

test('findOnPath finds executables and returns null otherwise', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ols-path-'));
  const name = process.platform === 'win32' ? 'mytool.exe' : 'mytool';
  fs.writeFileSync(path.join(dir, name), '');
  assert.equal(findOnPath('mytool', dir), path.join(dir, name));
  assert.equal(findOnPath('othertool', dir), null);
});

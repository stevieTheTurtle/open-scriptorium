// Bundles the extension host and the webview, and copies the PDF.js runtime files.
// The legacy PDF.js bundle is the default: the modern one needs browser features (Uint8Array.toHex)
// that are missing from the Chromium 132 in VS Code 1.99-based editors such as Cursor.
// Usage: node build.mjs [modern]
import * as esbuild from 'esbuild';
import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const flavor = process.argv[2] === 'modern' ? 'modern' : 'legacy';
const pdfjs = path.resolve('node_modules/pdfjs-dist');
const buildDir = flavor === 'legacy' ? path.join(pdfjs, 'legacy/build') : path.join(pdfjs, 'build');

await rm('dist', { recursive: true, force: true });
await mkdir('dist/pdfjs', { recursive: true });

await esbuild.build({
  entryPoints: ['src/extension.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['vscode'],
  outfile: 'dist/extension.js',
  sourcemap: true,
});

await esbuild.build({
  entryPoints: ['src/webview/main.js'],
  bundle: true,
  platform: 'browser',
  format: 'esm',
  target: 'chrome120',
  alias: { 'pdfjs-entry': path.join(buildDir, 'pdf.min.mjs') },
  outfile: 'dist/viewer.mjs',
  logOverride: { 'empty-import-meta': 'silent' },
});

await esbuild.build({
  entryPoints: ['test/e2e/suite.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['vscode'],
  outfile: 'out-e2e/suite.js',
});

await cp('src/webview/viewer.css', 'dist/viewer.css');
await cp(path.join(buildDir, 'pdf.worker.min.mjs'), 'dist/pdfjs/pdf.worker.min.mjs');
await cp(path.join(pdfjs, 'web/pdf_viewer.css'), 'dist/pdfjs/pdf_viewer.css');
for (const dir of ['wasm', 'standard_fonts', 'cmaps', 'iccs']) {
  await cp(path.join(pdfjs, dir), path.join('dist/pdfjs', dir), { recursive: true }).catch((e) => {
    console.warn(`missing PDF.js runtime folder ${dir}: ${e.code}`);
  });
}
await writeFile('dist/flavor.txt', flavor);
console.log(`built with PDF.js ${flavor} bundle`);

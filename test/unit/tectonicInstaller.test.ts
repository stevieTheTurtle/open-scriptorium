import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import {
  defaultTectonicBinDir,
  fallbackAssetsFor,
  installTectonic,
  isTrustedDownloadUrl,
  managedTectonicPath,
  selectReleaseAsset,
  targetTriplesFor,
  type GitHubRelease,
  type InstallProgress,
} from '../../src/tectonicInstaller.ts';

const SAMPLE_RELEASES: GitHubRelease[] = [
  {
    tag_name: 'tectonic_bridge_flate@0.2.0',
    draft: false,
    prerelease: false,
    assets: [],
  },
  {
    tag_name: 'tectonic@0.18.0-rc1',
    draft: false,
    prerelease: true,
    assets: [
      {
        name: 'tectonic-0.18.0-rc1-x86_64-pc-windows-msvc.zip',
        browser_download_url:
          'https://github.com/tectonic-typesetting/tectonic/releases/download/tectonic%400.18.0-rc1/tectonic-0.18.0-rc1-x86_64-pc-windows-msvc.zip',
      },
    ],
  },
  {
    tag_name: 'tectonic@0.17.0',
    draft: false,
    prerelease: false,
    assets: [
      {
        name: 'tectonic-0.17.0-x86_64-pc-windows-msvc.zip',
        browser_download_url:
          'https://github.com/tectonic-typesetting/tectonic/releases/download/tectonic%400.17.0/tectonic-0.17.0-x86_64-pc-windows-msvc.zip',
        size: 18_000_000,
      },
      {
        name: 'tectonic-0.17.0-aarch64-apple-darwin.tar.gz',
        browser_download_url:
          'https://github.com/tectonic-typesetting/tectonic/releases/download/tectonic%400.17.0/tectonic-0.17.0-aarch64-apple-darwin.tar.gz',
      },
      {
        name: 'tectonic-0.17.0-x86_64-unknown-linux-gnu.tar.gz',
        browser_download_url:
          'https://github.com/tectonic-typesetting/tectonic/releases/download/tectonic%400.17.0/tectonic-0.17.0-x86_64-unknown-linux-gnu.tar.gz',
      },
    ],
  },
];

test('targetTriplesFor maps supported platforms and rejects unsupported ones', () => {
  assert.deepEqual(targetTriplesFor('win32', 'x64'), {
    triples: ['x86_64-pc-windows-msvc'],
    archiveExt: '.zip',
  });
  assert.deepEqual(targetTriplesFor('darwin', 'arm64'), {
    triples: ['aarch64-apple-darwin', 'x86_64-apple-darwin'],
    archiveExt: '.tar.gz',
  });
  assert.deepEqual(targetTriplesFor('linux', 'x64'), {
    triples: ['x86_64-unknown-linux-gnu', 'x86_64-unknown-linux-musl'],
    archiveExt: '.tar.gz',
  });
  assert.equal(targetTriplesFor('freebsd', 'x64'), null);
});

test('selectReleaseAsset skips sub-crate tags and prereleases and picks the right platform asset', () => {
  const win = selectReleaseAsset(SAMPLE_RELEASES, 'win32', 'x64');
  assert.ok(win);
  assert.equal(win.tag, 'tectonic@0.17.0');
  assert.equal(win.assetName, 'tectonic-0.17.0-x86_64-pc-windows-msvc.zip');

  const macArm = selectReleaseAsset(SAMPLE_RELEASES, 'darwin', 'arm64');
  assert.ok(macArm);
  assert.equal(macArm.assetName, 'tectonic-0.17.0-aarch64-apple-darwin.tar.gz');

  const linux = selectReleaseAsset(SAMPLE_RELEASES, 'linux', 'x64');
  assert.ok(linux);
  assert.equal(linux.assetName, 'tectonic-0.17.0-x86_64-unknown-linux-gnu.tar.gz');

  // Windows ARM64 falls back to x86_64 asset when no ARM64 asset is published.
  const winArm = selectReleaseAsset(SAMPLE_RELEASES, 'win32', 'arm64');
  assert.ok(winArm);
  assert.equal(winArm.assetName, 'tectonic-0.17.0-x86_64-pc-windows-msvc.zip');
});

test('selectReleaseAsset rejects untrusted download URLs', () => {
  const untrusted: GitHubRelease[] = [
    {
      tag_name: 'tectonic@0.17.0',
      assets: [
        {
          name: 'tectonic-0.17.0-x86_64-pc-windows-msvc.zip',
          browser_download_url: 'https://evil.example.com/tectonic.zip',
        },
      ],
    },
  ];
  assert.equal(selectReleaseAsset(untrusted, 'win32', 'x64'), null);
  assert.equal(isTrustedDownloadUrl('https://evil.example.com/tectonic.zip'), false);
});

test('managedTectonicPath uses platform-appropriate executable name under ~/.open-scriptorium/bin', () => {
  const binDir = defaultTectonicBinDir('/home/alice');
  assert.equal(binDir, path.join('/home/alice', '.open-scriptorium', 'bin'));
  assert.equal(managedTectonicPath(binDir, 'win32'), path.join(binDir, 'tectonic.exe'));
  assert.equal(managedTectonicPath(binDir, 'linux'), path.join(binDir, 'tectonic'));
});

test('fallbackAssetsFor produces encoded GitHub download URLs', () => {
  const assets = fallbackAssetsFor('win32', 'x64', '0.17.0');
  assert.equal(assets.length, 1);
  assert.equal(
    assets[0].downloadUrl,
    'https://github.com/tectonic-typesetting/tectonic/releases/download/tectonic%400.17.0/tectonic-0.17.0-x86_64-pc-windows-msvc.zip',
  );
});

test('installTectonic downloads, extracts, verifies, and installs the binary cleanly', async () => {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'os-tectonic-'));
  const phases: InstallProgress['phase'][] = [];

  const fetchImpl = (async (input: string | URL) => {
    const url = String(input);
    if (url.includes('api.github.com')) {
      return new Response(JSON.stringify(SAMPLE_RELEASES), { status: 200 });
    }
    return new Response(new Uint8Array([80, 75, 3, 4]), {
      status: 200,
      headers: { 'content-length': '4' },
    });
  }) as unknown as typeof fetch;

  const result = await installTectonic({
    binDir,
    platform: 'win32',
    arch: 'x64',
    fetchImpl,
    onProgress: (p) => phases.push(p.phase),
    extractImpl: async (_archivePath, destDir) => {
      fs.mkdirSync(destDir, { recursive: true });
      fs.writeFileSync(path.join(destDir, 'tectonic.exe'), 'fake-binary');
    },
    verifyImpl: async () => 'Tectonic 0.17.0',
  });

  assert.equal(result.executable, path.join(binDir, 'tectonic.exe'));
  assert.equal(result.version, 'Tectonic 0.17.0');
  assert.equal(result.tag, 'tectonic@0.17.0');
  assert.equal(fs.readFileSync(result.executable, 'utf8'), 'fake-binary');
  assert.ok(phases.includes('resolving'));
  assert.ok(phases.includes('downloading'));
  assert.ok(phases.includes('extracting'));
  assert.ok(phases.includes('verifying'));
  // Temp install folder must be cleaned up.
  assert.deepEqual(fs.readdirSync(binDir), ['tectonic.exe']);
});

test('installTectonic falls back to direct release download when GitHub API is rate-limited', async () => {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'os-tectonic-fallback-'));
  const requestedUrls: string[] = [];

  const fetchImpl = (async (input: string | URL) => {
    const url = String(input);
    requestedUrls.push(url);
    if (url.includes('api.github.com')) {
      return new Response('rate limit exceeded', { status: 403, statusText: 'Forbidden' });
    }
    return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
  }) as unknown as typeof fetch;

  const result = await installTectonic({
    binDir,
    platform: 'linux',
    arch: 'x64',
    fetchImpl,
    extractImpl: async (_archivePath, destDir) => {
      fs.mkdirSync(path.join(destDir, 'nested'), { recursive: true });
      fs.writeFileSync(path.join(destDir, 'nested', 'tectonic'), 'elf-binary');
    },
    verifyImpl: async () => 'Tectonic 0.17.0',
  });

  assert.equal(result.executable, path.join(binDir, 'tectonic'));
  assert.ok(requestedUrls.some((u) => u.includes('/releases/download/tectonic%40')));
  assert.equal(fs.existsSync(result.executable), true);
});

test('installTectonic preserves an existing binary if verification fails', async () => {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'os-tectonic-fail-'));
  const existing = path.join(binDir, 'tectonic.exe');
  fs.writeFileSync(existing, 'good-old-binary');

  const fetchImpl = (async (input: string | URL) => {
    const url = String(input);
    if (url.includes('api.github.com')) {
      return new Response(JSON.stringify(SAMPLE_RELEASES), { status: 200 });
    }
    return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
  }) as unknown as typeof fetch;

  await assert.rejects(
    installTectonic({
      binDir,
      platform: 'win32',
      arch: 'x64',
      fetchImpl,
      extractImpl: async (_archivePath, destDir) => {
        fs.mkdirSync(destDir, { recursive: true });
        fs.writeFileSync(path.join(destDir, 'tectonic.exe'), 'corrupt-binary');
      },
      verifyImpl: async () => {
        throw new Error('bad binary');
      },
    }),
    /bad binary/,
  );

  assert.equal(fs.readFileSync(existing, 'utf8'), 'good-old-binary');
  assert.deepEqual(fs.readdirSync(binDir), ['tectonic.exe']);
});

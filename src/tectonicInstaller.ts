// Downloads and installs a managed Tectonic binary into ~/.open-scriptorium/bin/.
// No editor dependencies so it can be unit-tested directly with Node.

import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export const TECTONIC_RELEASES_API = 'https://api.github.com/repos/tectonic-typesetting/tectonic/releases?per_page=20';
export const FALLBACK_TECTONIC_VERSION = '0.17.0';

const ALLOWED_DOWNLOAD_PREFIX = 'https://github.com/tectonic-typesetting/tectonic/releases/download/';

export interface GitHubReleaseAsset {
  name: string;
  browser_download_url: string;
  size?: number;
}

export interface GitHubRelease {
  tag_name: string;
  draft?: boolean;
  prerelease?: boolean;
  assets?: GitHubReleaseAsset[];
}

export interface TargetSpec {
  triples: string[];
  archiveExt: '.zip' | '.tar.gz';
}

export interface ResolvedTectonicAsset {
  tag: string;
  version: string;
  assetName: string;
  downloadUrl: string;
  archiveExt: '.zip' | '.tar.gz';
  size?: number;
}

export interface InstallProgress {
  phase: 'resolving' | 'downloading' | 'extracting' | 'verifying';
  message: string;
  receivedBytes?: number;
  totalBytes?: number;
}

export interface InstallTectonicOptions {
  binDir?: string;
  platform?: NodeJS.Platform;
  arch?: string;
  signal?: AbortSignal;
  onProgress?: (progress: InstallProgress) => void;
  fetchImpl?: typeof fetch;
  extractImpl?: (archivePath: string, destDir: string, archiveExt: '.zip' | '.tar.gz', platform: NodeJS.Platform) => Promise<void>;
  verifyImpl?: (executable: string) => Promise<string>;
}

export interface InstallTectonicResult {
  executable: string;
  version: string;
  tag: string;
  assetName: string;
}

export function defaultTectonicBinDir(homeDir = os.homedir()): string {
  return path.join(homeDir, '.open-scriptorium', 'bin');
}

export function tectonicBinaryName(platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? 'tectonic.exe' : 'tectonic';
}

export function managedTectonicPath(
  binDir = defaultTectonicBinDir(),
  platform: NodeJS.Platform = process.platform,
): string {
  return path.join(binDir, tectonicBinaryName(platform));
}

/** Maps Node platform/arch to Tectonic release target triples in preference order. */
export function targetTriplesFor(platform: NodeJS.Platform, arch: string): TargetSpec | null {
  if (platform === 'win32') {
    if (arch === 'x64') return { triples: ['x86_64-pc-windows-msvc'], archiveExt: '.zip' };
    if (arch === 'arm64') return { triples: ['aarch64-pc-windows-msvc', 'x86_64-pc-windows-msvc'], archiveExt: '.zip' };
    return null;
  }
  if (platform === 'darwin') {
    if (arch === 'arm64') return { triples: ['aarch64-apple-darwin', 'x86_64-apple-darwin'], archiveExt: '.tar.gz' };
    if (arch === 'x64') return { triples: ['x86_64-apple-darwin'], archiveExt: '.tar.gz' };
    return null;
  }
  if (platform === 'linux') {
    if (arch === 'x64') return { triples: ['x86_64-unknown-linux-gnu', 'x86_64-unknown-linux-musl'], archiveExt: '.tar.gz' };
    if (arch === 'arm64') return { triples: ['aarch64-unknown-linux-gnu', 'aarch64-unknown-linux-musl'], archiveExt: '.tar.gz' };
    return null;
  }
  return null;
}

export function isTrustedDownloadUrl(url: string): boolean {
  return url.startsWith(ALLOWED_DOWNLOAD_PREFIX);
}

/** Selects the newest stable `tectonic@*` release asset matching the host platform/arch. */
export function selectReleaseAsset(
  releases: GitHubRelease[],
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): ResolvedTectonicAsset | null {
  const spec = targetTriplesFor(platform, arch);
  if (!spec) return null;

  for (const release of releases) {
    if (release.draft || release.prerelease) continue;
    if (!release.tag_name?.startsWith('tectonic@')) continue;
    const version = release.tag_name.slice('tectonic@'.length);
    if (!version) continue;
    const assets = release.assets ?? [];

    for (const triple of spec.triples) {
      const exactName = `tectonic-${version}-${triple}${spec.archiveExt}`;
      const asset =
        assets.find((a) => a.name === exactName) ??
        assets.find((a) => a.name.startsWith('tectonic-') && a.name.includes(triple) && a.name.endsWith(spec.archiveExt));
      if (!asset) continue;
      if (!isTrustedDownloadUrl(asset.browser_download_url)) continue;
      return {
        tag: release.tag_name,
        version,
        assetName: asset.name,
        downloadUrl: asset.browser_download_url,
        archiveExt: spec.archiveExt,
        size: asset.size,
      };
    }
  }
  return null;
}

/** Direct download URLs for a known release when the GitHub API is rate-limited or unavailable. */
export function fallbackAssetsFor(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
  version = FALLBACK_TECTONIC_VERSION,
): ResolvedTectonicAsset[] {
  const spec = targetTriplesFor(platform, arch);
  if (!spec) return [];
  const tag = `tectonic@${version}`;
  const encodedTag = encodeURIComponent(tag);
  return spec.triples.map((triple) => {
    const assetName = `tectonic-${version}-${triple}${spec.archiveExt}`;
    return {
      tag,
      version,
      assetName,
      downloadUrl: `${ALLOWED_DOWNLOAD_PREFIX}${encodedTag}/${assetName}`,
      archiveExt: spec.archiveExt,
    };
  });
}

async function resolveCandidateAssets(
  platform: NodeJS.Platform,
  arch: string,
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
): Promise<ResolvedTectonicAsset[]> {
  const spec = targetTriplesFor(platform, arch);
  if (!spec) {
    throw new Error(`Automatic Tectonic installation is not supported on ${platform}/${arch}. Install Tectonic manually and set "openScriptorium.tectonicPath".`);
  }

  const candidates: ResolvedTectonicAsset[] = [];
  try {
    const res = await fetchImpl(TECTONIC_RELEASES_API, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'open-scriptorium',
      },
      signal,
    });
    if (res.ok) {
      const data = (await res.json()) as unknown;
      if (Array.isArray(data)) {
        const selected = selectReleaseAsset(data as GitHubRelease[], platform, arch);
        if (selected) candidates.push(selected);
      }
    }
  } catch (err) {
    if (signal?.aborted) throw err;
    // Fall back to the pinned release URL below if GitHub API is unreachable or rate-limited.
  }

  for (const fallback of fallbackAssetsFor(platform, arch)) {
    if (!candidates.some((c) => c.downloadUrl === fallback.downloadUrl)) {
      candidates.push(fallback);
    }
  }
  return candidates;
}

async function downloadFile(
  url: string,
  destPath: string,
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
  onChunk?: (receivedBytes: number, totalBytes?: number) => void,
): Promise<void> {
  const res = await fetchImpl(url, {
    headers: { 'User-Agent': 'open-scriptorium' },
    redirect: 'follow',
    signal,
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText}`.trim());
  }
  if (!res.body) {
    const buf = Buffer.from(await res.arrayBuffer());
    await fs.writeFile(destPath, buf);
    onChunk?.(buf.length, buf.length);
    return;
  }

  const contentLengthHeader = res.headers.get('content-length');
  const totalBytes = contentLengthHeader ? Number(contentLengthHeader) : undefined;
  const total = totalBytes && Number.isFinite(totalBytes) && totalBytes > 0 ? totalBytes : undefined;

  const handle = await fs.open(destPath, 'w');
  let received = 0;
  try {
    const reader = res.body.getReader();
    for (;;) {
      if (signal?.aborted) {
        await reader.cancel();
        throw new Error('Download cancelled');
      }
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.byteLength > 0) {
        await handle.write(value);
        received += value.byteLength;
        onChunk?.(received, total);
      }
    }
  } finally {
    await handle.close();
  }
}

function runHelper(command: string, args: string[], timeoutMs = 60000): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    const child = spawn(command, args, { windowsHide: true });
    const timer = setTimeout(() => {
      child.kill();
    }, timeoutMs);
    child.stdout?.setEncoding('utf8').on('data', (d) => (stdout += d));
    child.stderr?.setEncoding('utf8').on('data', (d) => (stderr += d));
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: err.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

export async function extractArchive(
  archivePath: string,
  destDir: string,
  archiveExt: '.zip' | '.tar.gz',
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  await fs.mkdir(destDir, { recursive: true });
  if (archiveExt === '.tar.gz') {
    const res = await runHelper('tar', ['-xzf', archivePath, '-C', destDir]);
    if (res.code !== 0) {
      throw new Error(`tar extraction failed (exit ${res.code}): ${res.stderr.trim() || res.stdout.trim()}`);
    }
    return;
  }

  // .zip on Windows: try built-in bsdtar first (fast, no PowerShell policy overhead), fall back to Expand-Archive.
  const tarRes = await runHelper('tar', ['-xf', archivePath, '-C', destDir]);
  if (tarRes.code === 0) return;

  if (platform === 'win32') {
    const escapedArchive = archivePath.replace(/'/g, "''");
    const escapedDest = destDir.replace(/'/g, "''");
    const psRes = await runHelper('powershell', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `Expand-Archive -LiteralPath '${escapedArchive}' -DestinationPath '${escapedDest}' -Force`,
    ]);
    if (psRes.code === 0) return;
    throw new Error(`Archive extraction failed: ${psRes.stderr.trim() || tarRes.stderr.trim()}`);
  }

  const unzipRes = await runHelper('unzip', ['-o', archivePath, '-d', destDir]);
  if (unzipRes.code !== 0) {
    throw new Error(`Zip extraction failed: ${unzipRes.stderr.trim() || tarRes.stderr.trim()}`);
  }
}

export async function findBinaryInDir(dir: string, binaryName: string): Promise<string | null> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isFile() && entry.name.toLowerCase() === binaryName.toLowerCase()) {
      return full;
    }
    if (entry.isDirectory()) {
      const nested = await findBinaryInDir(full, binaryName);
      if (nested) return nested;
    }
  }
  return null;
}

export async function verifyTectonicBinary(executable: string): Promise<string> {
  const res = await runHelper(executable, ['--version'], 15000);
  if (res.code !== 0) {
    throw new Error(`Tectonic verification failed (exit ${res.code}): ${res.stderr.trim() || res.stdout.trim()}`);
  }
  const output = (res.stdout || res.stderr).trim().split(/\r?\n/)[0]?.trim() ?? '';
  if (!output) {
    throw new Error('Tectonic verification returned empty version output.');
  }
  return output;
}

async function replaceFile(source: string, target: string): Promise<void> {
  const backup = `${target}.old.${process.pid}`;
  const hadTarget = existsSync(target);
  try {
    if (hadTarget) {
      await fs.rm(backup, { force: true });
      await fs.rename(target, backup);
    }
    await fs.rename(source, target);
    if (hadTarget) {
      await fs.rm(backup, { force: true }).catch(() => {});
    }
  } catch (err) {
    if (hadTarget && !existsSync(target) && existsSync(backup)) {
      await fs.rename(backup, target).catch(() => {});
    }
    throw err;
  }
}

export async function installTectonic(options: InstallTectonicOptions = {}): Promise<InstallTectonicResult> {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const binDir = options.binDir ?? defaultTectonicBinDir();
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const extractImpl = options.extractImpl ?? extractArchive;
  const verifyImpl = options.verifyImpl ?? verifyTectonicBinary;
  const signal = options.signal;

  if (typeof fetchImpl !== 'function') {
    throw new Error('Fetch API is unavailable in this Node runtime.');
  }

  options.onProgress?.({ phase: 'resolving', message: 'Checking latest Tectonic release...' });
  const candidates = await resolveCandidateAssets(platform, arch, fetchImpl, signal);
  if (!candidates.length) {
    throw new Error(`No prebuilt Tectonic binary is available for ${platform}/${arch}.`);
  }

  await fs.mkdir(binDir, { recursive: true });
  const tempDir = await fs.mkdtemp(path.join(binDir, '.tectonic-install-'));
  const binaryName = tectonicBinaryName(platform);
  const finalPath = managedTectonicPath(binDir, platform);

  try {
    let chosen: ResolvedTectonicAsset | undefined;
    let archivePath = '';
    let lastError: unknown;

    for (const candidate of candidates) {
      if (signal?.aborted) throw new Error('Tectonic installation cancelled.');
      archivePath = path.join(tempDir, candidate.assetName);
      options.onProgress?.({
        phase: 'downloading',
        message: `Downloading ${candidate.assetName}...`,
        receivedBytes: 0,
        totalBytes: candidate.size,
      });
      try {
        await downloadFile(candidate.downloadUrl, archivePath, fetchImpl, signal, (receivedBytes, totalBytes) => {
          options.onProgress?.({
            phase: 'downloading',
            message: `Downloading ${candidate.assetName}...`,
            receivedBytes,
            totalBytes: totalBytes ?? candidate.size,
          });
        });
        chosen = candidate;
        break;
      } catch (err) {
        if (signal?.aborted) throw err;
        lastError = err;
        await fs.rm(archivePath, { force: true }).catch(() => {});
      }
    }

    if (!chosen) {
      const reason = lastError instanceof Error ? lastError.message : String(lastError);
      throw new Error(`Could not download Tectonic: ${reason}`);
    }

    options.onProgress?.({ phase: 'extracting', message: `Extracting ${chosen.assetName}...` });
    const extractDir = path.join(tempDir, 'extracted');
    await extractImpl(archivePath, extractDir, chosen.archiveExt, platform);

    const extractedBinary = await findBinaryInDir(extractDir, binaryName);
    if (!extractedBinary) {
      throw new Error(`Archive ${chosen.assetName} did not contain ${binaryName}.`);
    }

    if (platform !== 'win32') {
      await fs.chmod(extractedBinary, 0o755);
    }

    options.onProgress?.({ phase: 'verifying', message: 'Verifying Tectonic binary...' });
    const version = await verifyImpl(extractedBinary);

    await replaceFile(extractedBinary, finalPath);

    return {
      executable: finalPath,
      version,
      tag: chosen.tag,
      assetName: chosen.assetName,
    };
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

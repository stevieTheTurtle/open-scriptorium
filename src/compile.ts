// Runs Tectonic for one main file. No editor dependencies, so it can be tested on its own.

import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { parseCompilerIssues, type Issue } from './issues.ts';

export interface OutputPaths {
  pdfPath: string;
  synctexPath: string;
}

export interface CompileRequest extends OutputPaths {
  executable: string;
  mainFile: string;
  outDir: string;
  /** Delete the previous PDF and SyncTeX files first. */
  clean?: boolean;
  onOutput?: (text: string) => void;
  signal?: AbortSignal;
}

export interface CompileResult {
  success: boolean;
  exitCode: number | null;
  durationMs: number;
  issues: Issue[];
  log: string;
  /** Set when the compiler could not be started at all. */
  error?: string;
}

export function outputPathsFor(mainFile: string, outDir: string): OutputPaths {
  const base = path.basename(mainFile, path.extname(mainFile));
  return { pdfPath: path.join(outDir, `${base}.pdf`), synctexPath: path.join(outDir, `${base}.synctex.gz`) };
}

/** Looks for an executable on PATH, trying the Windows executable extensions. */
export function findOnPath(name: string, envPath = process.env.PATH ?? ''): string | null {
  const extensions = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const dir of envPath.split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of extensions) {
      const candidate = path.join(dir, name + ext);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

export async function runTectonic(request: CompileRequest): Promise<CompileResult> {
  const started = Date.now();
  await fs.mkdir(request.outDir, { recursive: true });
  if (request.clean) {
    // Only the files this build owns: outDir is user-configurable, so never empty it wholesale.
    await fs.rm(request.pdfPath, { force: true });
    await fs.rm(request.synctexPath, { force: true });
  }

  // --untrusted keeps shell-escape and similar features off, whatever the document asks for.
  const args = ['--untrusted', '--synctex', '-o', request.outDir, request.mainFile];
  const mainName = path.basename(request.mainFile);

  return new Promise<CompileResult>((resolve) => {
    let log = '';
    const append = (text: string) => {
      log += text;
      request.onOutput?.(text);
    };
    const finish = (exitCode: number | null, error?: string) =>
      void isFresh(request.pdfPath, started).then((fresh) =>
        resolve({
          // Only a PDF written by THIS run counts; a leftover one must not be reported as success.
          success: exitCode === 0 && fresh && !error,
          exitCode,
          durationMs: Date.now() - started,
          issues: parseCompilerIssues(log, mainName),
          log,
          error,
        }),
      );

    const child = spawn(request.executable, args, {
      cwd: path.dirname(request.mainFile),
      windowsHide: true,
      signal: request.signal,
    });
    child.stdout.setEncoding('utf8').on('data', append);
    child.stderr.setEncoding('utf8').on('data', append);
    child.on('error', (error) => finish(null, error.message));
    child.on('close', (code) => finish(code));
  });
}

async function isFresh(pdfPath: string, startedMs: number): Promise<boolean> {
  try {
    return (await fs.stat(pdfPath)).mtimeMs >= startedMs - 1000;
  } catch {
    return false;
  }
}

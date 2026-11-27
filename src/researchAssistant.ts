// Bundled Research Assistant manager: 1-click setup wizard, CLI-first + opt-in MCP fallback
// registration (Antigravity plugin, Claude Code CLI, VS Code), warm local daemon / Web UI launcher,
// Zotero sync, and built-in citation status script runner.

import * as vscode from 'vscode';
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { findOnPath } from './compile.ts';
import type { FindSupportResponse } from './citationFinder.ts';
import { CONFIG_SECTION } from './project.ts';
import { ZoteroWatcher } from './zoteroWatcher.ts';
import {
  antigravityPluginDir,
  buildMcpLaunchSpec,
  claudeConfigPaths,
  cliLauncherPath,
  defaultInstallDir,
  detectExistingDataDir,
  detectZoteroDir,
  inspectClientRegistrations,
  installWorkspaceAgentFiles,
  readEmbeddingSettingsFromYaml,
  registerAntigravityPlugin,
  registerClaudeCode,
  registerVsCodeUserMcp,
  renderConfigYaml,
  renderSkillTemplate,
  resolveResearchAssistantPaths,
  syncBundledSource,
  vsCodeUserMcpPath,
  writeLauncherScripts,
  type EmbeddingProvider,
  type ResearchAssistantPaths,
  type ResearchAssistantSettings,
} from './researchAssistantConfig.ts';

export const MCP_PROVIDER_ID = 'openScriptorium.researchAssistant';

interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runProcess(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; onOutput?: (chunk: string) => void } = {},
): Promise<CommandResult> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      windowsHide: true,
    });
    child.stdout?.on('data', (d: Buffer) => {
      const s = d.toString('utf8');
      stdout += s;
      options.onOutput?.(s);
    });
    child.stderr?.on('data', (d: Buffer) => {
      const s = d.toString('utf8');
      stderr += s;
      options.onOutput?.(s);
    });
    child.on('error', (err) => {
      const msg = err.message;
      stderr += msg;
      options.onOutput?.(`${msg}\n`);
      resolve({ code: -1, stdout, stderr });
    });
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

function httpOk(url: string, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      res.resume();
      resolve((res.statusCode ?? 500) < 500);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

function httpPostJson<T>(
  url: string,
  payload: unknown,
  timeoutMs = 120000,
): Promise<{ status: number; data?: T; error?: string }> {
  return new Promise((resolve) => {
    const body = Buffer.from(JSON.stringify(payload), 'utf8');
    const parsed = new URL(url);
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || 80,
        path: parsed.pathname + parsed.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': body.length,
        },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          const status = res.statusCode ?? 500;
          if (status >= 200 && status < 300) {
            try {
              resolve({ status, data: JSON.parse(text) as T });
            } catch (err) {
              resolve({ status, error: `Invalid JSON response: ${(err as Error).message}` });
            }
          } else {
            let detail = text;
            try {
              const obj = JSON.parse(text);
              if (typeof obj?.detail === 'string') detail = obj.detail;
            } catch {
              // keep raw text
            }
            resolve({ status, error: detail || `HTTP ${status}` });
          }
        });
      },
    );
    req.on('error', (err) => resolve({ status: 0, error: err.message }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ status: 0, error: 'Request timed out' });
    });
    req.write(body);
    req.end();
  });
}

async function waitForUrl(
  url: string,
  maxMs = 30000,
  shouldAbort?: () => boolean,
): Promise<boolean> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    if (shouldAbort?.()) return false;
    if (await httpOk(url, 1000)) return true;
    await new Promise((r) => setTimeout(r, 350));
  }
  return false;
}

async function detectPython310Plus(preferred?: string): Promise<{ cmd: string; argsPrefix: string[]; version: string } | null> {
  const candidates: Array<{ cmd: string; argsPrefix: string[] }> = [];
  if (preferred?.trim()) candidates.push({ cmd: preferred.trim(), argsPrefix: [] });
  if (process.platform === 'win32') {
    candidates.push({ cmd: 'python', argsPrefix: [] }, { cmd: 'py', argsPrefix: ['-3'] }, { cmd: 'python3', argsPrefix: [] });
  } else {
    candidates.push({ cmd: 'python3', argsPrefix: [] }, { cmd: 'python', argsPrefix: [] });
  }

  for (const c of candidates) {
    const resolved = path.isAbsolute(c.cmd) ? (fs.existsSync(c.cmd) ? c.cmd : null) : findOnPath(c.cmd);
    if (!resolved) continue;
    const res = await runProcess(resolved, [...c.argsPrefix, '-c', 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}")']);
    if (res.code !== 0) continue;
    const version = res.stdout.trim();
    const parts = version.split('.').map(Number);
    if (parts[0] > 3 || (parts[0] === 3 && parts[1] >= 10)) {
      return { cmd: resolved, argsPrefix: c.argsPrefix, version };
    }
  }
  return null;
}

export class ResearchAssistantService implements vscode.Disposable {
  private readonly context: vscode.ExtensionContext;
  private readonly output: vscode.OutputChannel;
  private readonly syncedEmitter = new vscode.EventEmitter<void>();
  private readonly mcpChangedEmitter = new vscode.EventEmitter<void>();
  private webUiProcess: ChildProcess | null = null;
  private daemonStarting: Promise<{ ok: boolean; error?: string }> | null = null;
  private syncRunning: Promise<boolean> | undefined;
  private syncTimer: NodeJS.Timeout | undefined;
  private zoteroWatcher: ZoteroWatcher | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  readonly onDidSyncZotero = this.syncedEmitter.event;

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
    this.output = vscode.window.createOutputChannel('Open Scriptorium — Research Assistant');
    this.disposables.push(
      this.output,
      this.syncedEmitter,
      this.mcpChangedEmitter,
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration(`${CONFIG_SECTION}.researchAssistant`)) {
          this.mcpChangedEmitter.fire();
          this.restartPeriodicSync();
          this.refreshLaunchersIfInstalled();
          const settings = this.getSettings();
          if (settings.enabled && settings.autoStartDaemon) {
            void this.ensureDaemonRunning({ silent: true });
          }
        }
      }),
    );

    this.syncBundledIfInstalled();
    this.refreshLaunchersIfInstalled();
    this.registerBuiltInVsCodeMcpProvider();
    this.restartPeriodicSync();

    const settings = this.getSettings();
    if (settings.enabled && settings.autoStartDaemon && vscode.workspace.isTrusted) {
      void this.ensureDaemonRunning({ silent: true });
    }
  }

  dispose(): void {
    if (this.syncTimer) clearInterval(this.syncTimer);
    this.zoteroWatcher?.stop();
    if (this.webUiProcess && !this.webUiProcess.killed) {
      this.webUiProcess.kill();
      this.webUiProcess = null;
    }
    for (const d of this.disposables) d.dispose();
  }

  get extensionVersion(): string {
    return String(this.context.extension.packageJSON?.version ?? '0.2.0');
  }

  get bundledSourceDir(): string {
    return path.join(this.context.extensionPath, 'research-assistant');
  }

  get bundledCitationStatusScript(): string {
    return path.join(this.bundledSourceDir, 'scripts', 'citation_status.py');
  }

  getSettings(): ResearchAssistantSettings {
    const cfg = vscode.workspace.getConfiguration(CONFIG_SECTION);
    return {
      enabled: cfg.get<boolean>('researchAssistant.enabled', true),
      installDir: cfg.get<string>('researchAssistant.installDir', ''),
      pythonPath: cfg.get<string>('researchAssistant.pythonPath', ''),
      dataDir: cfg.get<string>('researchAssistant.dataDir', ''),
      collection: cfg.get<string>('researchAssistant.collection', 'Zotero'),
      zoteroDir: cfg.get<string>('researchAssistant.zoteroDir', ''),
      zoteroSyncIntervalMinutes: cfg.get<number>('researchAssistant.zoteroSyncIntervalMinutes', 0),
      zoteroWatch: cfg.get<boolean>('researchAssistant.zoteroWatch', true),
      webUiPort: cfg.get<number>('researchAssistant.webUiPort', 8000),
      mcpFallback: cfg.get<boolean>('researchAssistant.mcpFallback', false),
      autoStartDaemon: cfg.get<boolean>('researchAssistant.autoStartDaemon', true),
    };
  }

  getPaths(): ResearchAssistantPaths {
    return resolveResearchAssistantPaths(this.getSettings());
  }

  /** Finds a Python executable suitable for running the stdlib-only citation_status.py script. */
  resolvePythonForCitationStatus(): string | null {
    const settings = this.getSettings();
    const paths = this.getPaths();
    if (settings.pythonPath.trim() && fs.existsSync(settings.pythonPath.trim())) {
      return settings.pythonPath.trim();
    }
    if (fs.existsSync(paths.venvPython)) return paths.venvPython;
    return process.platform === 'win32'
      ? findOnPath('python') ?? findOnPath('python3')
      : findOnPath('python3') ?? findOnPath('python');
  }

  /** Returns the citation status runner inputs when Research Assistant is enabled and its DB exists. */
  getBuiltInCitationStatusRunner(): { python: string; script: string; dbPath: string } | null {
    const settings = this.getSettings();
    if (!settings.enabled) return null;
    const paths = this.getPaths();
    if (!fs.existsSync(paths.metadataDbPath)) return null;
    const script = this.bundledCitationStatusScript;
    if (!fs.existsSync(script)) return null;
    const python = this.resolvePythonForCitationStatus();
    if (!python) return null;
    return { python, script, dbPath: paths.metadataDbPath };
  }

  private readAgentTemplates(paths: ResearchAssistantPaths): { skillMd: string; agentsMd: string; logoSvg?: string } {
    const base = path.join(this.context.extensionPath, 'agent-plugin');
    const rawSkillMd = fs.readFileSync(path.join(base, 'skills', 'citation-evidence', 'SKILL.md'), 'utf8');
    const skillMd = renderSkillTemplate(rawSkillMd, paths);
    const agentsMd = fs.readFileSync(path.join(base, 'rules', 'AGENTS.md'), 'utf8');
    const logoPath = path.join(base, 'assets', 'logo.svg');
    const logoSvg = fs.existsSync(logoPath) ? fs.readFileSync(logoPath, 'utf8') : undefined;
    return { skillMd, agentsMd, logoSvg };
  }

  /** Quietly refreshes installed Python source files when the extension updates (never touches .venv/data/config.yaml). */
  private syncBundledIfInstalled(): void {
    const paths = this.getPaths();
    if (!fs.existsSync(paths.venvPython) || !fs.existsSync(this.bundledSourceDir)) return;
    try {
      const updated = syncBundledSource(this.bundledSourceDir, paths.installDir, this.extensionVersion);
      if (updated) {
        this.output.appendLine(`[init] Updated Research Assistant source in ${paths.installDir} (v${this.extensionVersion})`);
      }
    } catch (err) {
      this.output.appendLine(`[init] Could not refresh bundled source: ${String(err)}`);
    }
  }

  private refreshLaunchersIfInstalled(): void {
    const paths = this.getPaths();
    if (!fs.existsSync(paths.venvPython)) return;
    try {
      writeLauncherScripts(paths, process.platform, this.getSettings().webUiPort || 8000);
    } catch {
      // Non-fatal
    }
  }

  /** Registers the VS Code 1.101+ built-in MCP Server Definition Provider (only active when mcpFallback is enabled). */
  private registerBuiltInVsCodeMcpProvider(): void {
    const api = vscode as unknown as {
      lm?: {
        registerMcpServerDefinitionProvider?: (
          id: string,
          provider: {
            onDidChangeMcpServerDefinitions?: vscode.Event<void>;
            provideMcpServerDefinitions(): unknown[];
          },
        ) => vscode.Disposable;
      };
      McpStdioServerDefinition?: new (
        label: string,
        command: string,
        args?: string[],
        env?: Record<string, string | number | null>,
        version?: string,
      ) => unknown;
    };
    if (!api.lm?.registerMcpServerDefinitionProvider || !api.McpStdioServerDefinition) return;
    const StdioDef = api.McpStdioServerDefinition;
    try {
      const disposable = api.lm.registerMcpServerDefinitionProvider(MCP_PROVIDER_ID, {
        onDidChangeMcpServerDefinitions: this.mcpChangedEmitter.event,
        provideMcpServerDefinitions: () => {
          const settings = this.getSettings();
          if (!settings.enabled || !settings.mcpFallback) return [];
          const paths = this.getPaths();
          if (!fs.existsSync(paths.venvPython)) return [];
          const spec = buildMcpLaunchSpec(paths, undefined, settings.webUiPort);
          return [new StdioDef('Research Assistant', spec.command, spec.args, spec.env, this.extensionVersion)];
        },
      });
      this.disposables.push(disposable);
    } catch {
      // Host editor exposes a partial or older lm API; user mcp.json handles VS Code registration.
    }
  }

  private restartPeriodicSync(): void {
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
      this.syncTimer = undefined;
    }
    this.zoteroWatcher?.stop();
    this.zoteroWatcher = undefined;
    const settings = this.getSettings();
    if (!settings.enabled) return;
    const paths = this.getPaths();
    if (!paths.zoteroDir || !fs.existsSync(paths.venvPython)) return;

    // Near-instant pickup of newly added PDFs: 1 s stat poll on Zotero's storage/ folder.
    if (settings.zoteroWatch !== false) {
      this.zoteroWatcher = new ZoteroWatcher({
        zoteroDir: paths.zoteroDir,
        onChange: () => {
          this.output.appendLine('\n[watch] New attachments detected in Zotero storage; syncing…');
          return this.syncZotero(true);
        },
      });
      this.zoteroWatcher.start();
    }

    const minutes = settings.zoteroSyncIntervalMinutes;
    if (!Number.isFinite(minutes) || minutes <= 0) return;
    const intervalMs = Math.max(5, minutes) * 60 * 1000;
    this.syncTimer = setInterval(() => {
      void this.syncZotero(true);
    }, intervalMs);
  }

  /** Interactive 1-click setup wizard for any new PC. */
  async setupWizard(): Promise<void> {
    if (!fs.existsSync(this.bundledSourceDir)) {
      void vscode.window.showErrorMessage('Open Scriptorium: bundled Research Assistant files are missing from this installation.');
      return;
    }

    const currentSettings = this.getSettings();
    const currentPaths = this.getPaths();
    const home = os.homedir();

    // 1. Check Python 3.10+
    const detectedPy = await detectPython310Plus(currentSettings.pythonPath);
    let pythonCmd = detectedPy?.cmd ?? '';
    let pythonArgsPrefix = detectedPy?.argsPrefix ?? [];
    if (!detectedPy) {
      const entered = await vscode.window.showInputBox({
        title: 'Research Assistant Setup (1/5): Python 3.10+',
        prompt: 'Python 3.10+ was not found on PATH. Enter the path to python.exe / python3.',
        placeHolder: process.platform === 'win32' ? 'C:\\Python312\\python.exe' : '/usr/bin/python3',
      });
      if (!entered) return;
      const verified = await detectPython310Plus(entered);
      if (!verified) {
        void vscode.window.showErrorMessage(`Open Scriptorium: "${entered}" is not a working Python 3.10+ executable.`);
        return;
      }
      pythonCmd = verified.cmd;
      pythonArgsPrefix = verified.argsPrefix;
    }

    // 2. Choose Data Directory (where metadata.db + ChromaDB vectors live)
    const detectedData = detectExistingDataDir(currentPaths.installDir, home, [currentSettings.dataDir]);
    const defaultData = path.join(currentPaths.installDir || defaultInstallDir(home), 'data');
    const dataItems: Array<vscode.QuickPickItem & { value: string }> = [];
    if (detectedData && path.resolve(detectedData) !== path.resolve(defaultData)) {
      dataItems.push({
        label: '$(cloud) Use detected existing library',
        description: detectedData,
        detail: 'Shares your existing Zotero/paper index (e.g. via OneDrive) across PCs',
        value: detectedData,
      });
    }
    dataItems.push(
      {
        label: '$(folder) Local default folder',
        description: defaultData,
        detail: 'Stores SQLite + vector index locally on this machine',
        value: defaultData,
      },
      {
        label: '$(folder-opened) Browse for data folder…',
        value: '__browse__',
      },
    );
    const dataPick = await vscode.window.showQuickPick(dataItems, {
      title: 'Research Assistant Setup (2/5): Paper Index Data Directory',
      placeHolder: 'Where should the Research Assistant database (metadata.db + ChromaDB) live?',
    });
    if (!dataPick) return;
    let chosenDataDir = dataPick.value;
    if (chosenDataDir === '__browse__') {
      const uris = await vscode.window.showOpenDialog({
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        openLabel: 'Select Research Assistant data folder',
      });
      if (!uris?.length) return;
      chosenDataDir = uris[0].fsPath;
    }

    // 3. Choose Zotero Directory (optional)
    const detectedZotero = detectZoteroDir(home, [currentSettings.zoteroDir, path.dirname(path.dirname(chosenDataDir))]);
    const zoteroItems: Array<vscode.QuickPickItem & { value: string }> = [];
    if (detectedZotero) {
      zoteroItems.push({
        label: '$(book) Use detected Zotero library',
        description: detectedZotero,
        detail: 'Found zotero.sqlite here',
        value: detectedZotero,
      });
    }
    zoteroItems.push(
      { label: '$(folder-opened) Browse for Zotero folder…', detail: 'Folder containing zotero.sqlite', value: '__browse__' },
      { label: '$(circle-slash) Skip Zotero sync for now', value: '' },
    );
    const zoteroPick = await vscode.window.showQuickPick(zoteroItems, {
      title: 'Research Assistant Setup (3/5): Zotero Library (Optional)',
      placeHolder: 'Select your Zotero data folder to enable automatic PDF indexing',
    });
    if (!zoteroPick) return;
    let chosenZoteroDir = zoteroPick.value;
    if (chosenZoteroDir === '__browse__') {
      const uris = await vscode.window.showOpenDialog({
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        openLabel: 'Select Zotero folder (containing zotero.sqlite)',
      });
      if (!uris?.length) return;
      chosenZoteroDir = uris[0].fsPath;
    }

    // 4. Embedding provider (pre-fill from existing sibling config.yaml or installDir config.yaml)
    const siblingConfig = path.join(path.dirname(chosenDataDir), 'config.yaml');
    const existingEmb = fs.existsSync(siblingConfig)
      ? readEmbeddingSettingsFromYaml(siblingConfig)
      : readEmbeddingSettingsFromYaml(currentPaths.configPath);

    const providerItems: Array<vscode.QuickPickItem & { value: EmbeddingProvider }> = [
      {
        label: 'sentence-transformers (Offline, all-MiniLM-L6-v2)',
        description: existingEmb.provider === 'sentence_transformers' ? 'Current' : 'Recommended for new PCs',
        detail: 'Runs locally without Ollama (~90 MB model downloaded on first use)',
        value: 'sentence_transformers',
      },
      {
        label: 'Ollama (nomic-embed-text)',
        description: existingEmb.provider === 'ollama' ? `Current (${existingEmb.ollamaUrl})` : 'Requires Ollama running',
        detail: 'Higher academic search quality; must match your existing shared ChromaDB if reusing an index',
        value: 'ollama',
      },
    ];
    if (existingEmb.provider === 'ollama') providerItems.reverse();

    const providerPick = await vscode.window.showQuickPick(providerItems, {
      title: 'Research Assistant Setup (4/5): Embedding Provider',
      placeHolder: 'Choose embedding backend (match your existing index if sharing data via cloud)',
    });
    if (!providerPick) return;
    const chosenProvider = providerPick.value;
    let chosenOllamaUrl = existingEmb.ollamaUrl;
    if (chosenProvider === 'ollama') {
      const url = await vscode.window.showInputBox({
        title: 'Research Assistant Setup (4/5): Ollama Base URL',
        prompt: 'Enter your Ollama server URL',
        value: existingEmb.ollamaUrl,
      });
      if (!url) return;
      chosenOllamaUrl = url.trim();
    }

    // 5. Select AI clients & CLI vs MCP fallback mode
    const modePick = await vscode.window.showQuickPick<vscode.QuickPickItem & { includeMcp: boolean }>(
      [
        {
          label: '$(terminal) CLI-first only (Recommended — lowest token usage)',
          description: 'Installs skills/rules using the fast `ra` CLI without attaching an MCP server',
          includeMcp: false,
        },
        {
          label: '$(plug) CLI + MCP fallback',
          description: 'Also registers the stdio MCP server for clients without shell access',
          includeMcp: true,
        },
      ],
      {
        title: 'Research Assistant Setup (5/5): Agent Integration Mode',
        placeHolder: 'How should AI assistants connect to Research Assistant?',
      },
    );
    if (!modePick) return;
    const includeMcp = modePick.includeMcp;

    const clientItems: Array<vscode.QuickPickItem & { id: 'antigravity' | 'claude' | 'vscode' }> = [
      {
        label: includeMcp
          ? 'Antigravity IDE (Plugin: CLI Skill + Rules + MCP fallback)'
          : 'Antigravity IDE (Plugin: CLI Skill + Rules)',
        description: antigravityPluginDir(home),
        picked: true,
        id: 'antigravity',
      },
      {
        label: includeMcp
          ? 'Claude Code CLI (CLI Skill + MCP fallback)'
          : 'Claude Code CLI (CLI Skill)',
        description: claudeConfigPaths(home).skillPath,
        picked: true,
        id: 'claude',
      },
      {
        label: 'VS Code (User mcp.json — only used when MCP fallback is enabled)',
        description: vsCodeUserMcpPath(home),
        picked: includeMcp,
        id: 'vscode',
      },
    ];
    const selectedClients = await vscode.window.showQuickPick(clientItems, {
      title: 'Research Assistant Setup (5/5): Register AI Clients',
      placeHolder: 'Choose which AI clients to configure automatically',
      canPickMany: true,
    });
    if (!selectedClients) return;

    // Install & configure
    const installDir = currentPaths.installDir;
    const finalPaths = resolveResearchAssistantPaths({
      ...currentSettings,
      installDir,
      dataDir: chosenDataDir,
      zoteroDir: chosenZoteroDir,
    });

    this.output.show(true);
    this.output.appendLine('=== Open Scriptorium: Research Assistant Setup ===');
    this.output.appendLine(`Install dir : ${finalPaths.installDir}`);
    this.output.appendLine(`Data dir    : ${finalPaths.dataDir}`);
    this.output.appendLine(`Zotero dir  : ${finalPaths.zoteroDir ?? '(none)'}`);
    this.output.appendLine(`Embeddings  : ${chosenProvider}${chosenProvider === 'ollama' ? ` (${chosenOllamaUrl})` : ''}`);
    this.output.appendLine(`Agent mode  : ${includeMcp ? 'CLI + MCP fallback' : 'CLI-first (no MCP)'}`);

    const ok = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'Open Scriptorium: Setting up Research Assistant',
        cancellable: false,
      },
      async (progress) => {
        const log = (chunk: string) => this.output.append(chunk);

        progress.report({ message: 'Copying bundled Python source…' });
        syncBundledSource(this.bundledSourceDir, finalPaths.installDir, this.extensionVersion);

        progress.report({ message: 'Writing config.yaml…' });
        fs.mkdirSync(finalPaths.dataDir, { recursive: true });
        fs.writeFileSync(
          finalPaths.configPath,
          renderConfigYaml({
            provider: chosenProvider,
            ollamaUrl: chosenOllamaUrl,
            ollamaModel: existingEmb.ollamaModel,
            dataDir: finalPaths.dataDir,
            port: currentSettings.webUiPort,
          }),
          'utf8',
        );

        const uvBin = findOnPath('uv');
        if (!fs.existsSync(finalPaths.venvPython)) {
          progress.report({ message: 'Creating Python virtual environment…' });
          this.output.appendLine(`\n> Creating .venv in ${finalPaths.venvDir}`);
          const venvRes = uvBin
            ? await runProcess(uvBin, ['venv', finalPaths.venvDir, '--python', pythonCmd], { onOutput: log })
            : await runProcess(pythonCmd, [...pythonArgsPrefix, '-m', 'venv', finalPaths.venvDir], { onOutput: log });
          if (venvRes.code !== 0 || !fs.existsSync(finalPaths.venvPython)) {
            this.output.appendLine('\n[error] Failed to create virtual environment.');
            return false;
          }
        } else {
          this.output.appendLine(`\n[ok] Reusing existing virtual environment at ${finalPaths.venvDir}`);
        }

        progress.report({ message: 'Installing Python dependencies (first run may take 2–4 min)…' });
        this.output.appendLine('\n> Installing Research Assistant dependencies…');
        const installRes = uvBin
          ? await runProcess(uvBin, ['pip', 'install', '--python', finalPaths.venvPython, '-e', finalPaths.installDir], {
              cwd: finalPaths.installDir,
              onOutput: log,
            })
          : await runProcess(finalPaths.venvPython, ['-m', 'pip', 'install', '-e', finalPaths.installDir], {
              cwd: finalPaths.installDir,
              onOutput: log,
            });
        if (installRes.code !== 0) {
          this.output.appendLine('\n[error] Dependency installation failed. See output above.');
          return false;
        }

        progress.report({ message: 'Initializing database…' });
        const env = { ...process.env, ...buildMcpLaunchSpec(finalPaths, undefined, currentSettings.webUiPort).env };
        const dbRes = await runProcess(
          finalPaths.venvPython,
          ['-c', 'from core.database import init_db; init_db(); print("DB_OK")'],
          { cwd: finalPaths.installDir, env, onOutput: log },
        );
        if (dbRes.code !== 0) {
          this.output.appendLine('\n[warn] Database initialization returned non-zero status (continuing).');
        }

        progress.report({ message: 'Creating CLI launchers & saving settings…' });
        writeLauncherScripts(finalPaths, process.platform, currentSettings.webUiPort || 8000);

        const cfg = vscode.workspace.getConfiguration(CONFIG_SECTION);
        await cfg.update('researchAssistant.dataDir', finalPaths.dataDir, vscode.ConfigurationTarget.Global);
        await cfg.update('researchAssistant.zoteroDir', finalPaths.zoteroDir ?? '', vscode.ConfigurationTarget.Global);
        await cfg.update('researchAssistant.mcpFallback', includeMcp, vscode.ConfigurationTarget.Global);

        progress.report({ message: 'Registering citation-evidence skills…' });
        const clientIds = new Set(selectedClients.map((c) => c.id));
        this.applyClientRegistrations(finalPaths, clientIds, includeMcp);
        this.mcpChangedEmitter.fire();
        this.output.appendLine(`\n[ok] Research Assistant setup complete! CLI: ${cliLauncherPath(finalPaths)}`);
        return true;
      },
    );

    if (!ok) {
      void vscode.window.showErrorMessage(
        'Open Scriptorium: Research Assistant setup failed. Check the "Open Scriptorium — Research Assistant" output log.',
      );
      return;
    }

    this.restartPeriodicSync();
    if (this.getSettings().autoStartDaemon) {
      void this.ensureDaemonRunning({ silent: true });
    }
    const actions: string[] = [];
    if (finalPaths.zoteroDir) actions.push('Sync Zotero Now');
    actions.push('Open Web UI', 'Show Log');
    const chosen = await vscode.window.showInformationMessage(
      includeMcp
        ? 'Research Assistant is ready (CLI + MCP fallback). Restart AI clients if needed to reload plugins/MCP.'
        : 'Research Assistant is ready in CLI-first mode! Restart AI clients if needed to pick up the updated skill.',
      ...actions,
    );
    if (chosen === 'Sync Zotero Now') {
      await this.syncZotero(false);
    } else if (chosen === 'Open Web UI') {
      await this.openWebUi();
    } else if (chosen === 'Show Log') {
      this.output.show(true);
    }
  }

  private applyClientRegistrations(
    paths: ResearchAssistantPaths,
    clients: Set<'antigravity' | 'claude' | 'vscode'>,
    includeMcp: boolean,
  ): void {
    const port = this.getSettings().webUiPort || 8000;
    writeLauncherScripts(paths, process.platform, port);
    const spec = buildMcpLaunchSpec(paths, undefined, port);
    const templates = this.readAgentTemplates(paths);
    if (clients.has('antigravity')) {
      const dir = registerAntigravityPlugin(spec, { ...templates, version: this.extensionVersion }, os.homedir(), { includeMcp });
      this.output.appendLine(`[ok] Antigravity plugin updated (${includeMcp ? 'CLI + MCP' : 'CLI-only'}) -> ${dir}`);
    }
    if (clients.has('claude')) {
      const res = registerClaudeCode(spec, templates.skillMd, os.homedir(), { includeMcp });
      this.output.appendLine(`[ok] Claude Code skill updated -> ${res.skillPath}`);
      if (includeMcp) this.output.appendLine(`[ok] Claude Code MCP registered -> ${res.claudeJsonPath}`);
    }
    if (clients.has('vscode')) {
      const mcpPath = registerVsCodeUserMcp(spec, os.homedir(), process.platform, process.env, { includeMcp });
      this.output.appendLine(`[ok] VS Code user mcp.json ${includeMcp ? 'registered' : 'cleaned'} -> ${mcpPath}`);
    }
  }

  /** Re-registers CLI skills (and optional MCP fallback) without recreating .venv. */
  async registerClientsInteractive(): Promise<void> {
    const paths = this.getPaths();
    if (!fs.existsSync(paths.venvPython)) {
      const run = await vscode.window.showWarningMessage(
        'Research Assistant is not installed yet. Run the setup wizard first?',
        'Run Setup',
      );
      if (run === 'Run Setup') await this.setupWizard();
      return;
    }

    const currentMcp = this.getSettings().mcpFallback;
    const modePick = await vscode.window.showQuickPick<vscode.QuickPickItem & { includeMcp: boolean }>(
      [
        {
          label: '$(terminal) CLI-first only (Recommended — lowest tokens)',
          description: currentMcp ? 'Switch off MCP' : 'Current',
          detail: 'Uses the fast `ra` CLI in skills; removes unused MCP server configs',
          includeMcp: false,
        },
        {
          label: '$(plug) CLI + MCP fallback',
          description: currentMcp ? 'Current' : 'Enable MCP fallback',
          detail: 'Installs CLI skills AND registers stdio MCP server for clients without shell access',
          includeMcp: true,
        },
      ],
      { title: 'Research Assistant: Choose Agent Integration Mode' },
    );
    if (!modePick) return;
    const includeMcp = modePick.includeMcp;

    const status = inspectClientRegistrations();
    const items: Array<vscode.QuickPickItem & { id: 'antigravity' | 'claude' | 'vscode' }> = [
      {
        label: 'Antigravity IDE (Plugin: Skill + Rules' + (includeMcp ? ' + MCP' : '') + ')',
        description: status.antigravity ? (status.antigravityMcp ? 'Registered (with MCP)' : 'Registered (CLI)') : 'Not registered',
        picked: true,
        id: 'antigravity',
      },
      {
        label: 'Claude Code CLI (Skill' + (includeMcp ? ' + MCP' : '') + ')',
        description: status.claudeCode ? (status.claudeCodeMcp ? 'Registered (with MCP)' : 'Registered (CLI)') : 'Not registered',
        picked: true,
        id: 'claude',
      },
      {
        label: 'VS Code (User mcp.json)',
        description: status.vsCodeUser ? 'MCP registered' : 'Not registered',
        picked: includeMcp || status.vsCodeUser,
        id: 'vscode',
      },
    ];
    const picked = await vscode.window.showQuickPick(items, {
      title: 'Research Assistant: Update AI Client Registrations',
      canPickMany: true,
    });
    if (!picked?.length) return;

    await vscode.workspace
      .getConfiguration(CONFIG_SECTION)
      .update('researchAssistant.mcpFallback', includeMcp, vscode.ConfigurationTarget.Global);
    this.applyClientRegistrations(paths, new Set(picked.map((p) => p.id)), includeMcp);
    this.mcpChangedEmitter.fire();
    void vscode.window.showInformationMessage(
      `Research Assistant updated (${includeMcp ? 'CLI + MCP fallback' : 'CLI-only'}) for ${picked.map((p) => p.id).join(', ')}. Restart those clients if already running.`,
    );
  }

  /** Runs incremental Zotero PDF sync into the Research Assistant index. */
  async syncZotero(silent = false): Promise<boolean> {
    if (this.syncRunning) {
      if (!silent) void vscode.window.showInformationMessage('Research Assistant: Zotero sync is already running.');
      return this.syncRunning;
    }
    const paths = this.getPaths();
    if (!fs.existsSync(paths.venvPython)) {
      if (!silent) {
        const go = await vscode.window.showWarningMessage(
          'Research Assistant is not set up yet. Run Setup first to enable Zotero sync.',
          'Run Setup',
        );
        if (go === 'Run Setup') await this.setupWizard();
      }
      return false;
    }
    if (!paths.zoteroDir || !fs.existsSync(path.join(paths.zoteroDir, 'zotero.sqlite'))) {
      if (!silent) {
        void vscode.window.showWarningMessage(
          'Research Assistant: Zotero folder (containing zotero.sqlite) is not configured. Run Setup or set openScriptorium.researchAssistant.zoteroDir.',
        );
      }
      return false;
    }

    const script = path.join(paths.installDir, 'scripts', 'zotero_sync.py');
    const spec = buildMcpLaunchSpec(paths, undefined, this.getSettings().webUiPort);
    const args = [script, '--zotero-dir', paths.zoteroDir, '--collection', paths.collection];
    if (silent) args.push('--no-notify');

    const run = async (): Promise<boolean> => {
      this.output.appendLine(`\n> Syncing Zotero library from ${paths.zoteroDir}…`);
      const res = await runProcess(paths.venvPython, args, {
        cwd: paths.installDir,
        env: { ...process.env, ...spec.env },
        onOutput: (chunk) => this.output.append(chunk),
      });
      if (res.code === 0) {
        this.output.appendLine('[ok] Zotero sync complete.');
        this.syncedEmitter.fire();
        return true;
      }
      this.output.appendLine(`[error] Zotero sync exited with code ${res.code}.`);
      return false;
    };

    const pending = Promise.resolve(
      silent
        ? run()
        : vscode.window.withProgress(
            {
              location: vscode.ProgressLocation.Notification,
              title: 'Open Scriptorium: Syncing Zotero library…',
              cancellable: false,
            },
            run,
          ),
    ).finally(() => {
      this.syncRunning = undefined;
    });
    this.syncRunning = pending;

    const ok = await pending;
    if (!silent) {
      if (ok) {
        void vscode.window.showInformationMessage('Research Assistant: Zotero library synced and citation status refreshed.');
      } else {
        const openLog = await vscode.window.showErrorMessage(
          'Research Assistant: Zotero sync failed.',
          'Show Log',
        );
        if (openLog === 'Show Log') this.output.show(true);
      }
    }
    return ok;
  }

  /** Ensures the local Research Assistant HTTP daemon (backing both fast `ra` CLI and Web UI) is running. */
  async ensureDaemonRunning(options: { silent?: boolean } = {}): Promise<{ ok: boolean; url: string; error?: string }> {
    const settings = this.getSettings();
    const paths = this.getPaths();
    const port = settings.webUiPort || 8000;
    const baseUrl = `http://127.0.0.1:${port}`;
    const healthUrl = `${baseUrl}/api/health`;

    if (await httpOk(healthUrl)) {
      return { ok: true, url: baseUrl };
    }
    if (!fs.existsSync(paths.venvPython)) {
      return { ok: false, url: baseUrl, error: 'Research Assistant virtual environment is not installed.' };
    }

    if (this.daemonStarting) {
      const res = await this.daemonStarting;
      return { ...res, url: baseUrl };
    }

    const start = async (): Promise<{ ok: boolean; error?: string }> => {
      const spec = buildMcpLaunchSpec(paths, undefined, port);
      this.output.appendLine(`\n> Starting Research Assistant server on ${baseUrl}…`);
      const child = spawn(
        paths.venvPython,
        ['-m', 'cli', 'serve', '--no-browser', '--host', '127.0.0.1', '--port', String(port)],
        {
          cwd: paths.installDir,
          env: { ...process.env, ...spec.env },
          windowsHide: true,
        },
      );
      this.webUiProcess = child;

      let exited = false;
      let exitCode: number | null = null;
      let stderrTail = '';

      child.stdout?.on('data', (d: Buffer) => this.output.append(d.toString('utf8')));
      child.stderr?.on('data', (d: Buffer) => {
        const text = d.toString('utf8');
        this.output.append(text);
        stderrTail = (stderrTail + text).slice(-1200);
      });
      child.on('error', (err) => {
        exited = true;
        stderrTail = err.message;
        this.output.appendLine(`[error] Failed to spawn server: ${err.message}`);
      });
      child.on('exit', (code) => {
        exited = true;
        exitCode = code;
        if (this.webUiProcess === child) this.webUiProcess = null;
        if (code !== 0 && code !== null) {
          this.output.appendLine(`[error] Research Assistant server exited with code ${code}.`);
        }
      });

      const wait = () => waitForUrl(healthUrl, 30000, () => exited);
      const ready = options.silent
        ? await wait()
        : await vscode.window.withProgress(
            {
              location: vscode.ProgressLocation.Notification,
              title: `Starting Research Assistant on port ${port}…`,
            },
            wait,
          );

      if (ready) {
        this.output.appendLine(`[ok] Research Assistant server ready at ${baseUrl}`);
        return { ok: true };
      }
      const lastLine = stderrTail
        .trim()
        .split(/\r?\n/)
        .filter(Boolean)
        .slice(-2)
        .join(' | ');
      const error = exited
        ? `Server exited early (code ${exitCode ?? '?'}): ${lastLine || 'see output log'}`
        : `Server did not respond on ${baseUrl} in time.`;
      return { ok: false, error };
    };

    this.daemonStarting = start().finally(() => {
      this.daemonStarting = null;
    });
    const result = await this.daemonStarting;
    return { ...result, url: baseUrl };
  }

  /** Queries the local Research Assistant (warm daemon with CLI fallback) for supporting citations. */
  async findSupportingCitations(
    claim: string,
    options: {
      topK?: number;
      recallK?: number;
      useReranker?: boolean;
      rerankerModel?: string;
    } = {},
  ): Promise<{ ok: boolean; data?: FindSupportResponse; error?: string; needsSetup?: boolean }> {
    const paths = this.getPaths();
    if (!fs.existsSync(paths.venvPython)) {
      return {
        ok: false,
        needsSetup: true,
        error: 'Research Assistant is not set up yet. Run "Research Assistant: Set Up / Configure" first.',
      };
    }
    if (!fs.existsSync(paths.metadataDbPath)) {
      return {
        ok: false,
        needsSetup: true,
        error: `No Research Assistant paper database found at ${paths.metadataDbPath}. Sync Zotero or run Setup first.`,
      };
    }

    const topK = options.topK ?? 8;
    const recallK = options.recallK ?? 30;
    const useReranker = options.useReranker !== false;
    const rerankerModel = options.rerankerModel?.trim() || undefined;

    // 1. Try warm local daemon first (~150-400 ms once CrossEncoder is cached in RAM).
    const daemon = await this.ensureDaemonRunning({ silent: true });
    if (daemon.ok) {
      const resp = await httpPostJson<FindSupportResponse>(
        `${daemon.url}/api/citations/find-support`,
        {
          claim,
          top_k: topK,
          recall_k: recallK,
          use_reranker: useReranker,
          reranker_model: rerankerModel ?? null,
        },
        300000,
      );
      if (resp.data) return { ok: true, data: resp.data };
      // If an older daemon is still running on this port (404), fall through cleanly to direct CLI execution.
      if (resp.status !== 404 && resp.status !== 0) {
        return { ok: false, error: resp.error ?? `HTTP ${resp.status}` };
      }
    }

    // 2. Direct in-process Python CLI fallback (works even if an older daemon holds the port).
    const spec = buildMcpLaunchSpec(paths, undefined, this.getSettings().webUiPort || 8000);
    const args = [
      '-m',
      'cli',
      'find-support',
      claim,
      '--top-k',
      String(topK),
      '--recall-k',
      String(recallK),
      '--local',
      '--json',
    ];
    if (!useReranker) args.push('--no-rerank');
    if (rerankerModel) args.push('--model', rerankerModel);

    const run = await runProcess(paths.venvPython, args, {
      cwd: paths.installDir,
      env: { ...process.env, ...spec.env },
    });
    if (run.code !== 0) {
      const errLine = (run.stderr || run.stdout).trim().split(/\r?\n/).slice(-3).join(' | ');
      return { ok: false, error: errLine || `Research Assistant exited with code ${run.code}` };
    }
    try {
      const parsed = JSON.parse(run.stdout) as FindSupportResponse;
      return { ok: true, data: parsed };
    } catch (err) {
      return { ok: false, error: `Could not parse Research Assistant response: ${(err as Error).message}` };
    }
  }

  /** Launches (if needed) and opens the Research Assistant Web UI in the default browser. */
  async openWebUi(): Promise<void> {
    const paths = this.getPaths();
    if (!fs.existsSync(paths.venvPython)) {
      const go = await vscode.window.showWarningMessage(
        'Research Assistant is not set up yet. Run Setup first to launch the Web UI.',
        'Run Setup',
      );
      if (go === 'Run Setup') await this.setupWizard();
      return;
    }

    const res = await this.ensureDaemonRunning({ silent: false });
    if (res.ok) {
      await vscode.env.openExternal(vscode.Uri.parse(res.url));
    } else {
      const openLog = await vscode.window.showErrorMessage(
        `Research Assistant Web UI failed to start: ${res.error ?? 'unknown error'}`,
        'Show Log',
      );
      if (openLog === 'Show Log') this.output.show(true);
    }
  }

  /** Installs citation-evidence skill + rules into the current workspace's .agents/ folder. */
  async installWorkspaceSkill(): Promise<void> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      void vscode.window.showWarningMessage('Open a workspace folder first to install workspace citation rules.');
      return;
    }
    const templates = this.readAgentTemplates(this.getPaths());
    const res = installWorkspaceAgentFiles(folder.uri.fsPath, templates);
    void vscode.window.showInformationMessage(
      `Installed citation-evidence skill in ${path.relative(folder.uri.fsPath, path.dirname(path.dirname(res.skillPath)))} and project rules in AGENTS.md (imported by CLAUDE.md).`,
    );
  }

  /** Shows an interactive status & actions dashboard in the Command Palette. */
  async showStatus(): Promise<void> {
    const settings = this.getSettings();
    const paths = this.getPaths();
    const venvReady = fs.existsSync(paths.venvPython);
    const dbReady = fs.existsSync(paths.metadataDbPath);
    const zoteroReady = Boolean(paths.zoteroDir && fs.existsSync(path.join(paths.zoteroDir, 'zotero.sqlite')));
    const port = settings.webUiPort || 8000;
    const daemonUp = await httpOk(`http://127.0.0.1:${port}/api/health`, 500);
    const clients = inspectClientRegistrations();
    const clientSummary = [
      `Antigravity ${clients.antigravity ? (clients.antigravityMcp ? 'CLI+MCP' : 'CLI') : '✗'}`,
      `Claude ${clients.claudeCode ? (clients.claudeCodeMcp ? 'CLI+MCP' : 'CLI') : '✗'}`,
      `VS Code MCP ${clients.vsCodeUser ? '✓' : 'off'}`,
    ].join('  ·  ');

    const items: Array<vscode.QuickPickItem & { action?: () => Promise<void> | void }> = [
      {
        label: venvReady ? '$(check) Environment Ready' : '$(warning) Environment Not Installed',
        description: `Daemon: ${daemonUp ? `running (:${port})` : 'stopped'}  ·  Mode: ${settings.mcpFallback ? 'CLI + MCP' : 'CLI-only'}`,
        detail: `DB: ${dbReady ? paths.metadataDbPath : 'not found'}  |  Zotero: ${zoteroReady ? paths.zoteroDir : 'not configured'}`,
      },
      {
        label: '$(plug) Registered AI Clients',
        description: clientSummary,
      },
      { label: '', kind: vscode.QuickPickItemKind.Separator },
      {
        label: '$(tools) Set Up / Reconfigure Research Assistant',
        detail: 'Create/update .venv, choose data & Zotero folder, configure embeddings & CLI/MCP',
        action: () => this.setupWizard(),
      },
      {
        label: '$(sync) Sync Zotero Library Now',
        detail: 'Index new/updated PDFs from Zotero and refresh citation highlights',
        action: () => this.syncZotero(false).then(() => undefined),
      },
      {
        label: '$(globe) Open Research Assistant Web UI',
        detail: `Launch http://127.0.0.1:${port}`,
        action: () => this.openWebUi(),
      },
      {
        label: '$(extensions) Register AI Clients (CLI / MCP Fallback)',
        detail: 'Configure Antigravity plugin, Claude Code skill/MCP, and VS Code mcp.json',
        action: () => this.registerClientsInteractive(),
      },
      {
        label: '$(file-add) Install Citation Rules in Current Workspace (.agents/)',
        detail: 'Copies CLI-first citation-evidence skill & rules into this repository',
        action: () => this.installWorkspaceSkill(),
      },
      {
        label: '$(output) Show Research Assistant Log',
        action: () => this.output.show(true),
      },
    ];

    const picked = await vscode.window.showQuickPick(items, {
      title: 'Open Scriptorium — Research Assistant Status',
      placeHolder: 'Choose an action',
    });
    if (picked?.action) await picked.action();
  }
}

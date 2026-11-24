// Bundled Research Assistant manager: 1-click setup wizard, MCP registration
// (Antigravity plugin, Claude Code CLI, VS Code), Zotero sync, Web UI launcher,
// and built-in citation status script runner.

import * as vscode from 'vscode';
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { findOnPath } from './compile.ts';
import { CONFIG_SECTION } from './project.ts';
import {
  antigravityPluginDir,
  buildMcpLaunchSpec,
  claudeConfigPaths,
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
  resolveResearchAssistantPaths,
  syncBundledSource,
  vsCodeUserMcpPath,
  writeLauncherScripts,
  type EmbeddingProvider,
  type ResearchAssistantPaths,
  type ResearchAssistantSettings,
} from './researchAssistantConfig.ts';

export const MCP_PROVIDER_ID = 'openLatexStudio.researchAssistant';

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

async function waitForUrl(url: string, maxMs = 20000): Promise<boolean> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    if (await httpOk(url, 1000)) return true;
    await new Promise((r) => setTimeout(r, 400));
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
  private syncRunning: Promise<boolean> | undefined;
  private syncTimer: NodeJS.Timeout | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  readonly onDidSyncZotero = this.syncedEmitter.event;

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
    this.output = vscode.window.createOutputChannel('Open LaTeX Studio — Research Assistant');
    this.disposables.push(
      this.output,
      this.syncedEmitter,
      this.mcpChangedEmitter,
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration(`${CONFIG_SECTION}.researchAssistant`)) {
          this.mcpChangedEmitter.fire();
          this.restartPeriodicSync();
        }
      }),
    );

    this.syncBundledIfInstalled();
    this.registerBuiltInVsCodeMcpProvider();
    this.restartPeriodicSync();
  }

  dispose(): void {
    if (this.syncTimer) clearInterval(this.syncTimer);
    if (this.webUiProcess && !this.webUiProcess.killed) {
      this.webUiProcess.kill();
      this.webUiProcess = null;
    }
    for (const d of this.disposables) d.dispose();
  }

  get extensionVersion(): string {
    return String(this.context.extension.packageJSON?.version ?? '0.1.0');
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
      webUiPort: cfg.get<number>('researchAssistant.webUiPort', 8000),
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

  private readAgentTemplates(): { skillMd: string; agentsMd: string; logoSvg?: string } {
    const base = path.join(this.context.extensionPath, 'agent-plugin');
    const skillMd = fs.readFileSync(path.join(base, 'skills', 'citation-evidence', 'SKILL.md'), 'utf8');
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

  /** Registers the VS Code 1.101+ built-in MCP Server Definition Provider when supported by the host editor. */
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
          if (!settings.enabled) return [];
          const paths = this.getPaths();
          if (!fs.existsSync(paths.venvPython)) return [];
          const spec = buildMcpLaunchSpec(paths);
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
    const settings = this.getSettings();
    const minutes = settings.zoteroSyncIntervalMinutes;
    if (!settings.enabled || !Number.isFinite(minutes) || minutes <= 0) return;
    const paths = this.getPaths();
    if (!paths.zoteroDir || !fs.existsSync(paths.venvPython)) return;
    const intervalMs = Math.max(5, minutes) * 60 * 1000;
    this.syncTimer = setInterval(() => {
      void this.syncZotero(true);
    }, intervalMs);
  }

  /** Interactive 1-click setup wizard for any new PC. */
  async setupWizard(): Promise<void> {
    if (!fs.existsSync(this.bundledSourceDir)) {
      void vscode.window.showErrorMessage('Open LaTeX Studio: bundled Research Assistant files are missing from this installation.');
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
        void vscode.window.showErrorMessage(`Open LaTeX Studio: "${entered}" is not a working Python 3.10+ executable.`);
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

    // 5. Select AI clients to register MCP + Skills/Rules
    const clientItems: Array<vscode.QuickPickItem & { id: 'antigravity' | 'claude' | 'vscode' }> = [
      {
        label: 'Antigravity IDE (Plugin: MCP + Citation Evidence Skill + Rules)',
        description: antigravityPluginDir(home),
        picked: true,
        id: 'antigravity',
      },
      {
        label: 'Claude Code CLI (User MCP + Citation Evidence Skill)',
        description: claudeConfigPaths(home).claudeJsonPath,
        picked: true,
        id: 'claude',
      },
      {
        label: 'VS Code (User mcp.json + Built-in MCP Provider)',
        description: vsCodeUserMcpPath(home),
        picked: true,
        id: 'vscode',
      },
    ];
    const selectedClients = await vscode.window.showQuickPick(clientItems, {
      title: 'Research Assistant Setup (5/5): Register MCP & Citation Rules',
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
    this.output.appendLine('=== Open LaTeX Studio: Research Assistant Setup ===');
    this.output.appendLine(`Install dir : ${finalPaths.installDir}`);
    this.output.appendLine(`Data dir    : ${finalPaths.dataDir}`);
    this.output.appendLine(`Zotero dir  : ${finalPaths.zoteroDir ?? '(none)'}`);
    this.output.appendLine(`Embeddings  : ${chosenProvider}${chosenProvider === 'ollama' ? ` (${chosenOllamaUrl})` : ''}`);

    const ok = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'Open LaTeX Studio: Setting up Research Assistant',
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
          this.output.appendLine(`\n▶ Creating .venv in ${finalPaths.venvDir}`);
          const venvRes = uvBin
            ? await runProcess(uvBin, ['venv', finalPaths.venvDir, '--python', pythonCmd], { onOutput: log })
            : await runProcess(pythonCmd, [...pythonArgsPrefix, '-m', 'venv', finalPaths.venvDir], { onOutput: log });
          if (venvRes.code !== 0 || !fs.existsSync(finalPaths.venvPython)) {
            this.output.appendLine('\n✗ Failed to create virtual environment.');
            return false;
          }
        } else {
          this.output.appendLine(`\n✓ Reusing existing virtual environment at ${finalPaths.venvDir}`);
        }

        progress.report({ message: 'Installing Python dependencies (first run may take 2–4 min)…' });
        this.output.appendLine('\n▶ Installing Research Assistant dependencies…');
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
          this.output.appendLine('\n✗ Dependency installation failed. See output above.');
          return false;
        }

        progress.report({ message: 'Initializing database…' });
        const env = { ...process.env, ...buildMcpLaunchSpec(finalPaths).env };
        const dbRes = await runProcess(
          finalPaths.venvPython,
          ['-c', 'from core.database import init_db; init_db(); print("DB_OK")'],
          { cwd: finalPaths.installDir, env, onOutput: log },
        );
        if (dbRes.code !== 0) {
          this.output.appendLine('\n! Database initialization returned non-zero status (continuing).');
        }

        progress.report({ message: 'Creating launcher scripts & saving settings…' });
        writeLauncherScripts(finalPaths);

        const cfg = vscode.workspace.getConfiguration(CONFIG_SECTION);
        await cfg.update('researchAssistant.dataDir', finalPaths.dataDir, vscode.ConfigurationTarget.Global);
        await cfg.update('researchAssistant.zoteroDir', finalPaths.zoteroDir ?? '', vscode.ConfigurationTarget.Global);

        progress.report({ message: 'Registering MCP server & citation-evidence skills…' });
        const clientIds = new Set(selectedClients.map((c) => c.id));
        this.applyClientRegistrations(finalPaths, clientIds);
        this.mcpChangedEmitter.fire();
        this.output.appendLine('\n✓ Research Assistant setup complete!');
        return true;
      },
    );

    if (!ok) {
      void vscode.window.showErrorMessage(
        'Open LaTeX Studio: Research Assistant setup failed. Check the "Open LaTeX Studio — Research Assistant" output log.',
      );
      return;
    }

    this.restartPeriodicSync();
    const actions: string[] = [];
    if (finalPaths.zoteroDir) actions.push('Sync Zotero Now');
    actions.push('Open Web UI', 'Show Log');
    const chosen = await vscode.window.showInformationMessage(
      'Research Assistant is ready! Restart Antigravity / Claude Code / VS Code if needed to pick up the new MCP server.',
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
  ): void {
    const spec = buildMcpLaunchSpec(paths);
    const templates = this.readAgentTemplates();
    if (clients.has('antigravity')) {
      const dir = registerAntigravityPlugin(spec, { ...templates, version: this.extensionVersion });
      this.output.appendLine(`✓ Antigravity plugin registered → ${dir}`);
    }
    if (clients.has('claude')) {
      const res = registerClaudeCode(spec, templates.skillMd);
      this.output.appendLine(`✓ Claude Code MCP registered → ${res.claudeJsonPath}`);
      this.output.appendLine(`✓ Claude Code skill installed → ${res.skillPath}`);
    }
    if (clients.has('vscode')) {
      const mcpPath = registerVsCodeUserMcp(spec);
      this.output.appendLine(`✓ VS Code user MCP registered → ${mcpPath}`);
    }
  }

  /** Re-registers MCP + skills without recreating .venv. */
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
    const status = inspectClientRegistrations();
    const items: Array<vscode.QuickPickItem & { id: 'antigravity' | 'claude' | 'vscode' }> = [
      {
        label: 'Antigravity IDE (Plugin: MCP + Skill + Rules)',
        description: status.antigravity ? 'Already registered (will update)' : 'Not registered',
        picked: true,
        id: 'antigravity',
      },
      {
        label: 'Claude Code CLI (MCP + Skill)',
        description: status.claudeCode ? 'Already registered (will update)' : 'Not registered',
        picked: true,
        id: 'claude',
      },
      {
        label: 'VS Code (User mcp.json)',
        description: status.vsCodeUser ? 'Already registered (will update)' : 'Not registered',
        picked: true,
        id: 'vscode',
      },
    ];
    const picked = await vscode.window.showQuickPick(items, {
      title: 'Research Assistant: Register MCP Server & Citation Evidence Skills',
      canPickMany: true,
    });
    if (!picked?.length) return;
    this.applyClientRegistrations(paths, new Set(picked.map((p) => p.id)));
    this.mcpChangedEmitter.fire();
    void vscode.window.showInformationMessage(
      `Research Assistant registered for ${picked.map((p) => p.id).join(', ')}. Restart those clients if already running.`,
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
          'Research Assistant: Zotero folder (containing zotero.sqlite) is not configured. Run Setup or set openLatexStudio.researchAssistant.zoteroDir.',
        );
      }
      return false;
    }

    const script = path.join(paths.installDir, 'scripts', 'zotero_sync.py');
    const spec = buildMcpLaunchSpec(paths);
    const args = [script, '--zotero-dir', paths.zoteroDir, '--collection', paths.collection];
    if (silent) args.push('--no-notify');

    const run = async (): Promise<boolean> => {
      this.output.appendLine(`\n▶ Syncing Zotero library from ${paths.zoteroDir}…`);
      const res = await runProcess(paths.venvPython, args, {
        cwd: paths.installDir,
        env: { ...process.env, ...spec.env },
        onOutput: (chunk) => this.output.append(chunk),
      });
      if (res.code === 0) {
        this.output.appendLine('✓ Zotero sync complete.');
        this.syncedEmitter.fire();
        return true;
      }
      this.output.appendLine(`✗ Zotero sync exited with code ${res.code}.`);
      return false;
    };

    const pending = Promise.resolve(
      silent
        ? run()
        : vscode.window.withProgress(
            {
              location: vscode.ProgressLocation.Notification,
              title: 'Open LaTeX Studio: Syncing Zotero library…',
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

  /** Launches (if needed) and opens the Research Assistant Web UI in the default browser. */
  async openWebUi(): Promise<void> {
    const settings = this.getSettings();
    const paths = this.getPaths();
    const port = settings.webUiPort || 8000;
    const baseUrl = `http://127.0.0.1:${port}`;
    const healthUrl = `${baseUrl}/api/papers`;

    if (await httpOk(healthUrl)) {
      await vscode.env.openExternal(vscode.Uri.parse(baseUrl));
      return;
    }

    if (!fs.existsSync(paths.venvPython)) {
      const go = await vscode.window.showWarningMessage(
        'Research Assistant is not set up yet. Run Setup first to launch the Web UI.',
        'Run Setup',
      );
      if (go === 'Run Setup') await this.setupWizard();
      return;
    }

    const spec = buildMcpLaunchSpec(paths);
    this.output.appendLine(`\n▶ Starting Research Assistant Web UI on ${baseUrl}…`);
    const child = spawn(paths.venvPython, ['-m', 'cli', 'serve', '--no-browser', '--port', String(port)], {
      cwd: paths.installDir,
      env: { ...process.env, ...spec.env },
      windowsHide: true,
    });
    this.webUiProcess = child;
    child.stdout?.on('data', (d: Buffer) => this.output.append(d.toString('utf8')));
    child.stderr?.on('data', (d: Buffer) => this.output.append(d.toString('utf8')));
    child.on('exit', () => {
      if (this.webUiProcess === child) this.webUiProcess = null;
    });

    const ready = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Starting Research Assistant Web UI on port ${port}…`,
      },
      () => waitForUrl(healthUrl, 25000),
    );

    if (ready) {
      await vscode.env.openExternal(vscode.Uri.parse(baseUrl));
    } else {
      const openLog = await vscode.window.showErrorMessage(
        'Research Assistant Web UI did not respond in time.',
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
    const templates = this.readAgentTemplates();
    const res = installWorkspaceAgentFiles(folder.uri.fsPath, templates);
    void vscode.window.showInformationMessage(
      `Installed citation-evidence skill and rules in ${path.relative(folder.uri.fsPath, path.dirname(path.dirname(res.skillPath)))}`,
    );
  }

  /** Shows an interactive status & actions dashboard in the Command Palette. */
  async showStatus(): Promise<void> {
    const paths = this.getPaths();
    const venvReady = fs.existsSync(paths.venvPython);
    const dbReady = fs.existsSync(paths.metadataDbPath);
    const zoteroReady = Boolean(paths.zoteroDir && fs.existsSync(path.join(paths.zoteroDir, 'zotero.sqlite')));
    const clients = inspectClientRegistrations();
    const clientSummary = [
      clients.antigravity ? 'Antigravity ✓' : 'Antigravity ✗',
      clients.claudeCode ? 'Claude Code ✓' : 'Claude Code ✗',
      clients.vsCodeUser ? 'VS Code ✓' : 'VS Code ✗',
    ].join('  ·  ');

    const items: Array<vscode.QuickPickItem & { action?: () => Promise<void> | void }> = [
      {
        label: venvReady ? '$(check) Environment Ready' : '$(warning) Environment Not Installed',
        description: paths.installDir,
        detail: `DB: ${dbReady ? paths.metadataDbPath : 'not found'}  |  Zotero: ${zoteroReady ? paths.zoteroDir : 'not configured'}`,
      },
      {
        label: '$(plug) Registered AI Clients',
        description: clientSummary,
      },
      { label: '', kind: vscode.QuickPickItemKind.Separator },
      {
        label: '$(tools) Set Up / Reconfigure Research Assistant',
        detail: 'Create/update .venv, choose data & Zotero folder, configure embeddings & MCP',
        action: () => this.setupWizard(),
      },
      {
        label: '$(sync) Sync Zotero Library Now',
        detail: 'Index new/updated PDFs from Zotero and refresh citation highlights',
        action: () => this.syncZotero(false).then(() => undefined),
      },
      {
        label: '$(globe) Open Research Assistant Web UI',
        detail: `Launch http://127.0.0.1:${this.getSettings().webUiPort || 8000}`,
        action: () => this.openWebUi(),
      },
      {
        label: '$(extensions) Register MCP & Citation Skills',
        detail: 'Write Antigravity plugin, Claude Code MCP/skill, and VS Code mcp.json',
        action: () => this.registerClientsInteractive(),
      },
      {
        label: '$(file-add) Install Citation Rules in Current Workspace (.agents/)',
        detail: 'Copies citation-evidence skill & rules into this repository',
        action: () => this.installWorkspaceSkill(),
      },
      {
        label: '$(output) Show Research Assistant Log',
        action: () => this.output.show(true),
      },
    ];

    const picked = await vscode.window.showQuickPick(items, {
      title: 'Open LaTeX Studio — Research Assistant Status',
      placeHolder: 'Choose an action',
    });
    if (picked?.action) await picked.action();
  }
}

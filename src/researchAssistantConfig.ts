// Pure path detection, config generation, and AI client registration helpers
// for the bundled Research Assistant CLI, warm daemon, opt-in MCP fallback & Zotero citation index.
// No vscode import, so everything here is directly unit-testable with node --test.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export const RESEARCH_ASSISTANT_SERVER_NAME = 'research-assistant';
export const ANTIGRAVITY_PLUGIN_DIR_NAME = 'open-scriptorium-research';
export const CITATION_SKILL_DIR_NAME = 'citation-evidence';

export type EmbeddingProvider = 'sentence_transformers' | 'ollama';

export interface ResearchAssistantSettings {
  enabled: boolean;
  installDir: string;
  pythonPath: string;
  dataDir: string;
  collection: string;
  zoteroDir: string;
  zoteroSyncIntervalMinutes: number;
  webUiPort: number;
  mcpFallback: boolean;
  autoStartDaemon: boolean;
}

export interface ResearchAssistantPaths {
  installDir: string;
  venvDir: string;
  venvPython: string;
  configPath: string;
  dataDir: string;
  zoteroDir: string | null;
  collection: string;
  metadataDbPath: string;
}

export interface McpLaunchSpec {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
}

export interface ClientRegistrationStatus {
  antigravity: boolean;
  antigravityMcp: boolean;
  claudeCode: boolean;
  claudeCodeMcp: boolean;
  vsCodeUser: boolean;
}

export interface RegistrationOptions {
  includeMcp?: boolean;
}

export function expandHome(input: string, homeDir: string = os.homedir()): string {
  const trimmed = input.trim();
  if (!trimmed) return '';
  if (trimmed === '~') return homeDir;
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
    return path.join(homeDir, trimmed.slice(2));
  }
  return trimmed;
}

export function defaultInstallDir(homeDir: string = os.homedir()): string {
  return path.join(homeDir, '.open-scriptorium', 'research-assistant');
}

export function venvPythonFor(installDir: string, platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32'
    ? path.join(installDir, '.venv', 'Scripts', 'python.exe')
    : path.join(installDir, '.venv', 'bin', 'python');
}

export function cliLauncherPath(paths: Pick<ResearchAssistantPaths, 'installDir'>, platform: NodeJS.Platform = process.platform): string {
  return path.join(paths.installDir, platform === 'win32' ? 'ra.bat' : 'ra');
}

/** Formats the `ra` CLI launcher invocation for embedding into SKILL.md (quoted only when needed). */
export function formatCliInvocation(paths: Pick<ResearchAssistantPaths, 'installDir'>, platform: NodeJS.Platform = process.platform): string {
  const launcher = cliLauncherPath(paths, platform);
  return /\s/.test(launcher) ? `"${launcher}"` : launcher;
}

/** Replaces `{{RA_CLI_CMD}}` placeholders in skill templates with the resolved `ra` launcher path. */
export function renderSkillTemplate(
  skillMd: string,
  paths: Pick<ResearchAssistantPaths, 'installDir'>,
  platform: NodeJS.Platform = process.platform,
): string {
  return skillMd.replaceAll('{{RA_CLI_CMD}}', formatCliInvocation(paths, platform));
}

/** Finds OneDrive* folders under the user's home directory, if any (follows Windows OneDrive junctions/reparse points). */
export function findOneDriveDirs(homeDir: string = os.homedir()): string[] {
  try {
    return fs
      .readdirSync(homeDir)
      .filter((name) => /^OneDrive/i.test(name))
      .map((name) => path.join(homeDir, name))
      .filter((full) => {
        try {
          return fs.statSync(full).isDirectory();
        } catch {
          return false;
        }
      })
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

/** Candidate directories where a Zotero data folder (containing zotero.sqlite) may live. */
export function detectZoteroDir(homeDir: string = os.homedir(), extraCandidates: string[] = []): string | null {
  const candidates = [
    ...extraCandidates.filter(Boolean).map((p) => expandHome(p, homeDir)),
    ...findOneDriveDirs(homeDir).map((d) => path.join(d, 'ZoteroDocuments')),
    path.join(homeDir, 'Zotero'),
  ];
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'zotero.sqlite'))) return dir;
  }
  return null;
}

/** Candidate directories where an existing Research Assistant `data/` folder may live. */
export function detectExistingDataDir(
  installDir: string,
  homeDir: string = os.homedir(),
  extraCandidates: string[] = [],
): string | null {
  const candidates = [
    ...extraCandidates.filter(Boolean).map((p) => expandHome(p, homeDir)),
    ...findOneDriveDirs(homeDir).map((d) => path.join(d, 'ZoteroDocuments', 'ResearchAssistant', 'data')),
    path.join(installDir, 'data'),
  ];
  for (const dir of candidates) {
    if (
      fs.existsSync(path.join(dir, 'collections')) ||
      fs.existsSync(path.join(dir, 'metadata.db')) ||
      fs.existsSync(path.join(dir, 'collections.json'))
    ) {
      return dir;
    }
  }
  return null;
}

/** Resolves the SQLite metadata.db path for a collection (falling back to legacy flat layout). */
export function resolveMetadataDbPath(dataDir: string, collection: string = 'Zotero'): string {
  const collectionDb = path.join(dataDir, 'collections', collection, 'metadata.db');
  if (fs.existsSync(collectionDb)) return collectionDb;
  const defaultDb = path.join(dataDir, 'collections', 'default', 'metadata.db');
  if (!fs.existsSync(collectionDb) && fs.existsSync(defaultDb) && collection === 'default') return defaultDb;
  const legacyDb = path.join(dataDir, 'metadata.db');
  if (fs.existsSync(legacyDb)) return legacyDb;
  return collectionDb;
}

/** Resolves all effective paths for Research Assistant from extension settings + auto-detection. */
export function resolveResearchAssistantPaths(
  settings: Partial<ResearchAssistantSettings>,
  homeDir: string = os.homedir(),
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): ResearchAssistantPaths {
  const installDir = settings.installDir?.trim()
    ? path.resolve(expandHome(settings.installDir, homeDir))
    : defaultInstallDir(homeDir);
  const venvDir = path.join(installDir, '.venv');
  const venvPython = venvPythonFor(installDir, platform);
  const configPath = path.join(installDir, 'config.yaml');
  const collection = settings.collection?.trim() || 'Zotero';

  let dataDir = '';
  if (settings.dataDir?.trim()) {
    dataDir = path.resolve(expandHome(settings.dataDir, homeDir));
  } else if (env.RA_DATA_DIR?.trim()) {
    dataDir = path.resolve(expandHome(env.RA_DATA_DIR, homeDir));
  } else {
    dataDir = detectExistingDataDir(installDir, homeDir) ?? path.join(installDir, 'data');
  }

  let zoteroDir: string | null = null;
  if (settings.zoteroDir?.trim()) {
    zoteroDir = path.resolve(expandHome(settings.zoteroDir, homeDir));
  } else if (env.ZOTERO_DIR?.trim()) {
    zoteroDir = path.resolve(expandHome(env.ZOTERO_DIR, homeDir));
  } else {
    zoteroDir = detectZoteroDir(homeDir, [path.dirname(path.dirname(dataDir))]);
  }

  const metadataDbPath = env.RA_ZOTERO_DB?.trim() && fs.existsSync(env.RA_ZOTERO_DB)
    ? env.RA_ZOTERO_DB
    : resolveMetadataDbPath(dataDir, collection);

  return {
    installDir,
    venvDir,
    venvPython,
    configPath,
    dataDir,
    zoteroDir,
    collection,
    metadataDbPath,
  };
}

/** Builds the launch specification and UTF-8 environment for Research Assistant Python processes. */
export function buildMcpLaunchSpec(
  paths: ResearchAssistantPaths,
  pythonOverride?: string,
  apiPort?: number,
): McpLaunchSpec {
  const command = pythonOverride?.trim() || paths.venvPython;
  const env: Record<string, string> = {
    RA_DATA_DIR: paths.dataDir,
    RA_CONFIG_PATH: paths.configPath,
    PYTHONPATH: paths.installDir,
    PYTHONUTF8: '1',
    PYTHONIOENCODING: 'utf-8',
  };
  if (paths.zoteroDir) env.ZOTERO_DIR = paths.zoteroDir;
  if (paths.collection) env.RA_ZOTERO_COLLECTION = paths.collection;
  if (apiPort && Number.isFinite(apiPort)) env.RA_API_URL = `http://127.0.0.1:${apiPort}`;
  return {
    command,
    args: ['-m', 'mcp_server'],
    cwd: paths.installDir,
    env,
  };
}

/** Reads embedding provider & Ollama URL from an existing config.yaml if present. */
export function readEmbeddingSettingsFromYaml(configPath: string): {
  provider: EmbeddingProvider;
  ollamaUrl: string;
  ollamaModel: string;
} {
  const defaults = {
    provider: 'sentence_transformers' as EmbeddingProvider,
    ollamaUrl: 'http://127.0.0.1:11434',
    ollamaModel: 'nomic-embed-text',
  };
  if (!fs.existsSync(configPath)) return defaults;
  try {
    const text = fs.readFileSync(configPath, 'utf8');
    const provMatch = /^\s*provider:\s*(ollama|sentence_transformers)\b/m.exec(text);
    const urlMatch = /^\s*base_url:\s*(\S+)/m.exec(text);
    const ollamaSection = text.split(/^\s*ollama:\s*$/m)[1] ?? '';
    const modelMatch = /^\s*model:\s*(\S+)/m.exec(ollamaSection);
    return {
      provider: (provMatch?.[1] as EmbeddingProvider | undefined) ?? defaults.provider,
      ollamaUrl: urlMatch?.[1] ?? defaults.ollamaUrl,
      ollamaModel: modelMatch?.[1] ?? defaults.ollamaModel,
    };
  } catch {
    return defaults;
  }
}

/** Renders a clean Research Assistant config.yaml. */
export function renderConfigYaml(options: {
  provider: EmbeddingProvider;
  ollamaUrl?: string;
  ollamaModel?: string;
  dataDir?: string;
  port?: number;
}): string {
  const ollamaUrl = options.ollamaUrl?.trim() || 'http://127.0.0.1:11434';
  const ollamaModel = options.ollamaModel?.trim() || 'nomic-embed-text';
  const port = options.port || 8000;
  const dataDir = options.dataDir?.trim() || 'data';
  return [
    'embedding:',
    '  # provider: sentence_transformers | ollama',
    `  provider: ${options.provider}`,
    '  sentence_transformers:',
    '    model: all-MiniLM-L6-v2',
    '  ollama:',
    `    model: ${ollamaModel}`,
    `    base_url: ${ollamaUrl}`,
    '',
    'chunking:',
    '  chunk_size: 400',
    '  chunk_overlap: 60',
    '',
    'retrieval:',
    '  top_k: 10',
    '  bm25_weight: 0.3',
    '  semantic_weight: 0.7',
    '  rrf_k: 60',
    '',
    'api:',
    '  host: 127.0.0.1',
    `  port: ${port}`,
    '',
    '# Overridden by RA_DATA_DIR when launched from Open Scriptorium',
    `data_dir: ${JSON.stringify(dataDir)}`,
    '',
  ].join('\n');
}

function readJsonObject(filePath: string): Record<string, unknown> {
  if (!fs.existsSync(filePath)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function writeJsonAtomic(filePath: string, data: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, filePath);
}

/** Resolves VS Code's user-level mcp.json path for the current OS. */
export function vsCodeUserMcpPath(
  homeDir: string = os.homedir(),
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (platform === 'win32') {
    const appData = env.APPDATA || path.join(homeDir, 'AppData', 'Roaming');
    return path.join(appData, 'Code', 'User', 'mcp.json');
  }
  if (platform === 'darwin') {
    return path.join(homeDir, 'Library', 'Application Support', 'Code', 'User', 'mcp.json');
  }
  const configHome = env.XDG_CONFIG_HOME || path.join(homeDir, '.config');
  return path.join(configHome, 'Code', 'User', 'mcp.json');
}

/** Resolves Antigravity's plugin root for the bundled Research Assistant plugin. */
export function antigravityPluginDir(homeDir: string = os.homedir()): string {
  return path.join(homeDir, '.gemini', 'config', 'plugins', ANTIGRAVITY_PLUGIN_DIR_NAME);
}

/** Resolves Claude Code's ~/.claude.json and user skill path. */
export function claudeConfigPaths(homeDir: string = os.homedir()): {
  claudeJsonPath: string;
  skillPath: string;
} {
  return {
    claudeJsonPath: path.join(homeDir, '.claude.json'),
    skillPath: path.join(homeDir, '.claude', 'skills', CITATION_SKILL_DIR_NAME, 'SKILL.md'),
  };
}

/**
 * Installs/updates the Antigravity plugin at ~/.gemini/config/plugins/open-scriptorium-research/.
 * CLI-first by default: only writes `mcp_config.json` when `options.includeMcp` is true, and removes
 * any stale `mcp_config.json` when false so Antigravity does not attach an unused MCP server.
 */
export function registerAntigravityPlugin(
  spec: McpLaunchSpec,
  templates: { skillMd: string; agentsMd: string; logoSvg?: string; version?: string },
  homeDir: string = os.homedir(),
  options: RegistrationOptions = {},
): string {
  const includeMcp = options.includeMcp ?? false;
  const dir = antigravityPluginDir(homeDir);
  const skillDir = path.join(dir, 'skills', CITATION_SKILL_DIR_NAME);
  const rulesDir = path.join(dir, 'rules');
  fs.mkdirSync(skillDir, { recursive: true });
  fs.mkdirSync(rulesDir, { recursive: true });

  writeJsonAtomic(path.join(dir, 'plugin.json'), {
    name: 'Open Scriptorium Research Assistant',
    description: includeMcp
      ? 'Local paper library CLI, opt-in MCP server, and citation evidence workflow bundled with Open Scriptorium.'
      : 'Local paper library CLI and citation evidence workflow bundled with Open Scriptorium.',
    version: templates.version ?? '0.2.0',
    repository: {
      type: 'git',
      url: 'https://github.com/stevieTheTurtle/open-scriptorium.git',
    },
  });

  const mcpConfigPath = path.join(dir, 'mcp_config.json');
  if (includeMcp) {
    writeJsonAtomic(mcpConfigPath, {
      mcpServers: {
        [RESEARCH_ASSISTANT_SERVER_NAME]: {
          command: spec.command,
          args: spec.args,
          env: spec.env,
        },
      },
    });
  } else if (fs.existsSync(mcpConfigPath)) {
    fs.rmSync(mcpConfigPath, { force: true });
  }

  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), templates.skillMd, 'utf8');
  fs.writeFileSync(path.join(rulesDir, 'AGENTS.md'), templates.agentsMd, 'utf8');
  if (templates.logoSvg) {
    const assetsDir = path.join(dir, 'assets');
    fs.mkdirSync(assetsDir, { recursive: true });
    fs.writeFileSync(path.join(assetsDir, 'logo.svg'), templates.logoSvg, 'utf8');
  }
  return dir;
}

/**
 * Installs the citation-evidence skill in ~/.claude/skills/citation-evidence/SKILL.md.
 * When `options.includeMcp` is true, registers the stdio MCP server in ~/.claude.json (preserving all other keys);
 * when false (CLI-first default), removes any existing `research-assistant` MCP entry if present.
 */
export function registerClaudeCode(
  spec: McpLaunchSpec,
  skillMd: string,
  homeDir: string = os.homedir(),
  options: RegistrationOptions = {},
): { claudeJsonPath: string; skillPath: string } {
  const includeMcp = options.includeMcp ?? false;
  const { claudeJsonPath, skillPath } = claudeConfigPaths(homeDir);

  if (includeMcp) {
    const root = readJsonObject(claudeJsonPath);
    const servers =
      root.mcpServers && typeof root.mcpServers === 'object' && !Array.isArray(root.mcpServers)
        ? { ...(root.mcpServers as Record<string, unknown>) }
        : {};
    servers[RESEARCH_ASSISTANT_SERVER_NAME] = {
      type: 'stdio',
      command: spec.command,
      args: spec.args,
      env: spec.env,
    };
    root.mcpServers = servers;
    writeJsonAtomic(claudeJsonPath, root);
  } else if (fs.existsSync(claudeJsonPath)) {
    const root = readJsonObject(claudeJsonPath);
    if (root.mcpServers && typeof root.mcpServers === 'object' && !Array.isArray(root.mcpServers)) {
      const servers = { ...(root.mcpServers as Record<string, unknown>) };
      if (RESEARCH_ASSISTANT_SERVER_NAME in servers) {
        delete servers[RESEARCH_ASSISTANT_SERVER_NAME];
        root.mcpServers = servers;
        writeJsonAtomic(claudeJsonPath, root);
      }
    }
  }

  fs.mkdirSync(path.dirname(skillPath), { recursive: true });
  fs.writeFileSync(skillPath, skillMd, 'utf8');
  return { claudeJsonPath, skillPath };
}

/**
 * Registers or removes the Research Assistant MCP server in VS Code's user mcp.json (preserving all other keys).
 */
export function registerVsCodeUserMcp(
  spec: McpLaunchSpec,
  homeDir: string = os.homedir(),
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  options: RegistrationOptions = { includeMcp: true },
): string {
  const includeMcp = options.includeMcp ?? true;
  const mcpPath = vsCodeUserMcpPath(homeDir, platform, env);
  if (includeMcp) {
    const root = readJsonObject(mcpPath);
    const servers =
      root.servers && typeof root.servers === 'object' && !Array.isArray(root.servers)
        ? { ...(root.servers as Record<string, unknown>) }
        : {};
    servers[RESEARCH_ASSISTANT_SERVER_NAME] = {
      type: 'stdio',
      command: spec.command,
      args: spec.args,
      env: spec.env,
    };
    root.servers = servers;
    writeJsonAtomic(mcpPath, root);
  } else if (fs.existsSync(mcpPath)) {
    const root = readJsonObject(mcpPath);
    if (root.servers && typeof root.servers === 'object' && !Array.isArray(root.servers)) {
      const servers = { ...(root.servers as Record<string, unknown>) };
      if (RESEARCH_ASSISTANT_SERVER_NAME in servers) {
        delete servers[RESEARCH_ASSISTANT_SERVER_NAME];
        root.servers = servers;
        writeJsonAtomic(mcpPath, root);
      }
    }
  }
  return mcpPath;
}

/** Installs the citation-evidence skill and rules into a workspace's .agents/ directory. */
export function installWorkspaceAgentFiles(
  workspaceRoot: string,
  templates: { skillMd: string; agentsMd: string },
): { skillPath: string; rulePath: string } {
  const skillPath = path.join(workspaceRoot, '.agents', 'skills', CITATION_SKILL_DIR_NAME, 'SKILL.md');
  const rulePath = path.join(workspaceRoot, '.agents', 'rules', 'citation-evidence.md');
  fs.mkdirSync(path.dirname(skillPath), { recursive: true });
  fs.mkdirSync(path.dirname(rulePath), { recursive: true });
  fs.writeFileSync(skillPath, templates.skillMd, 'utf8');
  fs.writeFileSync(rulePath, templates.agentsMd, 'utf8');
  return { skillPath, rulePath };
}

/** Checks which AI clients currently have Research Assistant skills/plugins and optional MCP registered. */
export function inspectClientRegistrations(
  homeDir: string = os.homedir(),
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): ClientRegistrationStatus {
  const agyDir = antigravityPluginDir(homeDir);
  const agySkill = fs.existsSync(path.join(agyDir, 'skills', CITATION_SKILL_DIR_NAME, 'SKILL.md'));
  const agyMcp = path.join(agyDir, 'mcp_config.json');
  const agyRoot = readJsonObject(agyMcp);
  const agyServers = agyRoot.mcpServers as Record<string, unknown> | undefined;
  const agyHasMcp = Boolean(agyServers?.[RESEARCH_ASSISTANT_SERVER_NAME]);

  const { claudeJsonPath, skillPath } = claudeConfigPaths(homeDir);
  const claudeRoot = readJsonObject(claudeJsonPath);
  const claudeServers = claudeRoot.mcpServers as Record<string, unknown> | undefined;
  const claudeHasMcp = Boolean(claudeServers?.[RESEARCH_ASSISTANT_SERVER_NAME]);

  const vsPath = vsCodeUserMcpPath(homeDir, platform, env);
  const vsRoot = readJsonObject(vsPath);
  const vsServers = vsRoot.servers as Record<string, unknown> | undefined;

  return {
    antigravity: agySkill || agyHasMcp,
    antigravityMcp: agyHasMcp,
    claudeCode: fs.existsSync(skillPath) || claudeHasMcp,
    claudeCodeMcp: claudeHasMcp,
    vsCodeUser: Boolean(vsServers?.[RESEARCH_ASSISTANT_SERVER_NAME]),
  };
}

/** Copies the bundled research-assistant Python source into a stable user install dir without touching .venv/data/config.yaml. */
export function syncBundledSource(
  bundledSourceDir: string,
  installDir: string,
  bundledVersion: string,
): boolean {
  const stampPath = path.join(installDir, '.bundled-version');
  const currentStamp = fs.existsSync(stampPath) ? fs.readFileSync(stampPath, 'utf8').trim() : '';
  const hasCore = fs.existsSync(path.join(installDir, 'mcp_server', 'server.py'));
  if (currentStamp === bundledVersion && hasCore) return false;

  fs.mkdirSync(installDir, { recursive: true });
  const subdirs = ['core', 'mcp_server', 'api', 'cli', 'ui', 'scripts'];
  for (const sub of subdirs) {
    const src = path.join(bundledSourceDir, sub);
    if (!fs.existsSync(src)) continue;
    fs.cpSync(src, path.join(installDir, sub), {
      recursive: true,
      force: true,
      filter: (p) => !p.includes('__pycache__') && !p.endsWith('.pyc'),
    });
  }
  for (const file of ['pyproject.toml', 'config.default.yaml']) {
    const src = path.join(bundledSourceDir, file);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, path.join(installDir, file));
    }
  }
  fs.writeFileSync(stampPath, `${bundledVersion}\n`, 'utf8');
  return true;
}

/** Writes portable launcher scripts (ra, ra-ui, ra-mcp, ra-zotero-sync) inside installDir. */
export function writeLauncherScripts(
  paths: ResearchAssistantPaths,
  platform: NodeJS.Platform = process.platform,
  apiPort = 8000,
): void {
  fs.mkdirSync(paths.installDir, { recursive: true });
  const apiUrl = `http://127.0.0.1:${apiPort || 8000}`;
  if (platform === 'win32') {
    const envBlock = [
      `set "RA_DATA_DIR=${paths.dataDir}"`,
      `set "RA_CONFIG_PATH=${paths.configPath}"`,
      `set "RA_API_URL=${apiUrl}"`,
      `set "RA_ZOTERO_COLLECTION=${paths.collection}"`,
      ...(paths.zoteroDir ? [`set "ZOTERO_DIR=${paths.zoteroDir}"`] : []),
      `set "PYTHONPATH=${paths.installDir}"`,
      `set "PYTHONUTF8=1"`,
      `set "PYTHONIOENCODING=utf-8"`,
    ].join('\r\n');
    const files: Record<string, string> = {
      'ra.bat': `@echo off\r\nsetlocal\r\n${envBlock}\r\n"${paths.venvPython}" -m cli %*\r\n`,
      'ra-ui.bat': `@echo off\r\nsetlocal\r\n${envBlock}\r\n"${paths.venvPython}" -m cli serve --port ${apiPort || 8000} %*\r\n`,
      'ra-mcp.bat': `@echo off\r\nsetlocal\r\n${envBlock}\r\n"${paths.venvPython}" -m mcp_server\r\n`,
      'ra-zotero-sync.bat': `@echo off\r\nsetlocal\r\n${envBlock}\r\n"${paths.venvPython}" "${path.join(paths.installDir, 'scripts', 'zotero_sync.py')}" %*\r\n`,
    };
    for (const [name, content] of Object.entries(files)) {
      fs.writeFileSync(path.join(paths.installDir, name), content, 'utf8');
    }
  } else {
    const envBlock = [
      `export RA_DATA_DIR=${JSON.stringify(paths.dataDir)}`,
      `export RA_CONFIG_PATH=${JSON.stringify(paths.configPath)}`,
      `export RA_API_URL=${JSON.stringify(apiUrl)}`,
      `export RA_ZOTERO_COLLECTION=${JSON.stringify(paths.collection)}`,
      ...(paths.zoteroDir ? [`export ZOTERO_DIR=${JSON.stringify(paths.zoteroDir)}`] : []),
      `export PYTHONPATH=${JSON.stringify(paths.installDir)}`,
      `export PYTHONUTF8=1`,
      `export PYTHONIOENCODING=utf-8`,
    ].join('\n');
    const files: Record<string, string> = {
      'ra': `#!/usr/bin/env bash\n${envBlock}\nexec ${JSON.stringify(paths.venvPython)} -m cli "$@"\n`,
      'ra-ui': `#!/usr/bin/env bash\n${envBlock}\nexec ${JSON.stringify(paths.venvPython)} -m cli serve --port ${apiPort || 8000} "$@"\n`,
      'ra-mcp': `#!/usr/bin/env bash\n${envBlock}\nexec ${JSON.stringify(paths.venvPython)} -m mcp_server\n`,
      'ra-zotero-sync': `#!/usr/bin/env bash\n${envBlock}\nexec ${JSON.stringify(paths.venvPython)} ${JSON.stringify(path.join(paths.installDir, 'scripts', 'zotero_sync.py'))} "$@"\n`,
    };
    for (const [name, content] of Object.entries(files)) {
      const target = path.join(paths.installDir, name);
      fs.writeFileSync(target, content, 'utf8');
      try {
        fs.chmodSync(target, 0o755);
      } catch {
        // Ignore chmod errors on non-POSIX filesystems
      }
    }
  }
}

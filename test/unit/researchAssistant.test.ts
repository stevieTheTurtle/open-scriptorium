import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import {
  ANTIGRAVITY_PLUGIN_DIR_NAME,
  RESEARCH_ASSISTANT_SERVER_NAME,
  antigravityPluginDir,
  buildMcpLaunchSpec,
  claudeConfigPaths,
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
} from '../../src/researchAssistantConfig.ts';

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('resolveResearchAssistantPaths detects OneDrive Zotero and shared data dir', () => {
  const home = makeTempDir('ols-home-');
  try {
    const oneDrive = path.join(home, 'OneDrive - Uni');
    const zoteroDir = path.join(oneDrive, 'ZoteroDocuments');
    const dataDir = path.join(zoteroDir, 'ResearchAssistant', 'data');
    const dbFile = path.join(dataDir, 'collections', 'Zotero', 'metadata.db');
    fs.mkdirSync(path.dirname(dbFile), { recursive: true });
    fs.writeFileSync(path.join(zoteroDir, 'zotero.sqlite'), '');
    fs.writeFileSync(dbFile, '');

    assert.equal(detectZoteroDir(home), zoteroDir);
    assert.equal(detectExistingDataDir(path.join(home, '.open-latex-studio', 'research-assistant'), home), dataDir);

    const resolved = resolveResearchAssistantPaths({}, home, 'win32', {});
    assert.equal(resolved.dataDir, dataDir);
    assert.equal(resolved.zoteroDir, zoteroDir);
    assert.equal(resolved.metadataDbPath, dbFile);
    assert.ok(resolved.venvPython.endsWith(path.join('.venv', 'Scripts', 'python.exe')));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('config.yaml render and round-trip readEmbeddingSettingsFromYaml', () => {
  const tmp = makeTempDir('ols-cfg-');
  try {
    const cfgPath = path.join(tmp, 'config.yaml');
    const yaml = renderConfigYaml({
      provider: 'ollama',
      ollamaUrl: 'http://127.0.0.1:11435',
      ollamaModel: 'nomic-embed-text',
      dataDir: '/shared/data',
      port: 8123,
    });
    fs.writeFileSync(cfgPath, yaml, 'utf8');
    const parsed = readEmbeddingSettingsFromYaml(cfgPath);
    assert.equal(parsed.provider, 'ollama');
    assert.equal(parsed.ollamaUrl, 'http://127.0.0.1:11435');
    assert.equal(parsed.ollamaModel, 'nomic-embed-text');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('registers Antigravity plugin, Claude Code MCP+skill, and VS Code user mcp.json preserving existing keys', () => {
  const home = makeTempDir('ols-clients-');
  const appData = path.join(home, 'AppData', 'Roaming');
  try {
    const paths = resolveResearchAssistantPaths(
      { dataDir: path.join(home, 'ra-data'), zoteroDir: path.join(home, 'Zotero') },
      home,
      'win32',
      {},
    );
    const spec = buildMcpLaunchSpec(paths);
    assert.deepEqual(spec.args, ['-m', 'mcp_server']);
    assert.equal(spec.env.RA_DATA_DIR, path.join(home, 'ra-data'));
    assert.equal(spec.env.ZOTERO_DIR, path.join(home, 'Zotero'));

    // Seed pre-existing Claude & VS Code config to make sure other entries survive untouched.
    const { claudeJsonPath } = claudeConfigPaths(home);
    fs.writeFileSync(
      claudeJsonPath,
      JSON.stringify({ otherSetting: 42, mcpServers: { existing: { command: 'foo' } } }),
      'utf8',
    );
    const vsPath = vsCodeUserMcpPath(home, 'win32', { APPDATA: appData });
    fs.mkdirSync(path.dirname(vsPath), { recursive: true });
    fs.writeFileSync(vsPath, JSON.stringify({ servers: { other: { command: 'bar' } } }), 'utf8');

    const templates = { skillMd: '# Skill\n', agentsMd: '# Rules\n', logoSvg: '<svg/>', version: '0.1.0' };
    const pluginDir = registerAntigravityPlugin(spec, templates, home);
    const claudeRes = registerClaudeCode(spec, templates.skillMd, home);
    const vsRes = registerVsCodeUserMcp(spec, home, 'win32', { APPDATA: appData });

    assert.equal(pluginDir, antigravityPluginDir(home));
    assert.ok(pluginDir.endsWith(ANTIGRAVITY_PLUGIN_DIR_NAME));
    assert.ok(fs.existsSync(path.join(pluginDir, 'plugin.json')));
    assert.ok(fs.existsSync(path.join(pluginDir, 'mcp_config.json')));
    assert.ok(fs.existsSync(path.join(pluginDir, 'skills', 'citation-evidence', 'SKILL.md')));
    assert.ok(fs.existsSync(path.join(pluginDir, 'rules', 'AGENTS.md')));
    assert.ok(fs.existsSync(path.join(pluginDir, 'assets', 'logo.svg')));

    const claudeParsed = JSON.parse(fs.readFileSync(claudeRes.claudeJsonPath, 'utf8'));
    assert.equal(claudeParsed.otherSetting, 42);
    assert.equal(claudeParsed.mcpServers.existing.command, 'foo');
    assert.equal(claudeParsed.mcpServers[RESEARCH_ASSISTANT_SERVER_NAME].command, spec.command);
    assert.equal(fs.readFileSync(claudeRes.skillPath, 'utf8'), '# Skill\n');

    const vsParsed = JSON.parse(fs.readFileSync(vsRes, 'utf8'));
    assert.equal(vsParsed.servers.other.command, 'bar');
    assert.equal(vsParsed.servers[RESEARCH_ASSISTANT_SERVER_NAME].command, spec.command);

    const status = inspectClientRegistrations(home, 'win32', { APPDATA: appData });
    assert.deepEqual(status, { antigravity: true, claudeCode: true, vsCodeUser: true });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('syncBundledSource copies python source, skips __pycache__, and preserves .venv/config.yaml', () => {
  const root = makeTempDir('ols-sync-');
  try {
    const src = path.join(root, 'bundled');
    const dst = path.join(root, 'installed');
    fs.mkdirSync(path.join(src, 'mcp_server', '__pycache__'), { recursive: true });
    fs.writeFileSync(path.join(src, 'mcp_server', 'server.py'), 'print("v1")');
    fs.writeFileSync(path.join(src, 'mcp_server', '__pycache__', 'server.cpython.pyc'), 'junk');
    fs.writeFileSync(path.join(src, 'pyproject.toml'), '[project]\nname="ra"\n');

    // Existing user files in installDir must be untouched
    fs.mkdirSync(path.join(dst, '.venv'), { recursive: true });
    fs.writeFileSync(path.join(dst, 'config.yaml'), 'custom: true\n');

    assert.equal(syncBundledSource(src, dst, '0.1.0'), true);
    assert.equal(syncBundledSource(src, dst, '0.1.0'), false); // second call is a no-op
    assert.equal(fs.readFileSync(path.join(dst, 'config.yaml'), 'utf8'), 'custom: true\n');
    assert.ok(fs.existsSync(path.join(dst, '.venv')));
    assert.ok(!fs.existsSync(path.join(dst, 'mcp_server', '__pycache__')));

    // Version bump updates source
    fs.writeFileSync(path.join(src, 'mcp_server', 'server.py'), 'print("v2")');
    assert.equal(syncBundledSource(src, dst, '0.1.1'), true);
    assert.equal(fs.readFileSync(path.join(dst, 'mcp_server', 'server.py'), 'utf8'), 'print("v2")');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('installWorkspaceAgentFiles and writeLauncherScripts write expected files', () => {
  const root = makeTempDir('ols-ws-');
  try {
    const wsRes = installWorkspaceAgentFiles(root, { skillMd: '# S', agentsMd: '# R' });
    assert.ok(fs.existsSync(wsRes.skillPath));
    assert.ok(fs.existsSync(wsRes.rulePath));

    const paths = resolveResearchAssistantPaths({ installDir: path.join(root, 'ra') }, root, 'win32', {});
    writeLauncherScripts(paths, 'win32');
    for (const f of ['ra.bat', 'ra-ui.bat', 'ra-mcp.bat', 'ra-zotero-sync.bat']) {
      assert.ok(fs.existsSync(path.join(paths.installDir, f)));
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

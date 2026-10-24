import { describe, expect, it } from 'vitest';
import { strings } from '../../../src/shared/i18n';
import type { Platform } from '../../../src/shared/platform';
import { AGENT_PRESETS } from '../../../src/shared/teammate/agents';
import {
  CONNECT_APPS, connectSnippet, mcpAddLine, mcpServersJson, type BridgeCommand, type ConnectShape,
} from '../../../src/shared/teammate/connectApps';

const BRIDGE = {
  command: 'C:\\Program Files\\lolPing\\lolPing.exe',
  args: ['C:\\Program Files\\lolPing\\resources\\out\\main\\bridge.js'],
  env: { ELECTRON_RUN_AS_NODE: '1', LOLPING_PIPE: '\\\\.\\pipe\\lolping-0123456789abcdef', LOLPING_DATA: 'C:\\Users\\a b' },
};

const ENV_LABEL = 'Environment variables:';
const snip = (shape: ConnectShape, b: BridgeCommand, platform: Platform): string =>
  connectSnippet(shape, b, platform, ENV_LABEL);

const app = (id: string) => {
  const found = CONNECT_APPS.find((a) => a.id === id);
  if (!found) throw new Error(`no app ${id}`);
  return found;
};

describe('CONNECT_APPS', () => {
  it('gives every app a snippet in its own shape', () => {
    const shapes = new Map<ConnectShape, string>();
    for (const a of CONNECT_APPS) {
      const text = snip(a.shape, BRIDGE, 'win');
      expect(text, a.id).not.toBe('');
      expect(text, a.id).toContain('lolping');
      expect(text, a.id).toContain('lolPing.exe');
      shapes.set(a.shape, text);
    }
    expect([...shapes.keys()].sort()).toEqual([
      'claudeCodeLine', 'context_servers', 'dshPatch', 'gooseLine', 'mcpServers', 'servers', 'toml',
    ]);
    expect(CONNECT_APPS.map((a) => a.id)).toEqual([...new Set(CONNECT_APPS.map((a) => a.id))]);
  });

  it('names every app in both languages, with the words between product names in Chinese', () => {
    const en = strings('en').teammate.settings;
    const zh = strings('zh-CN').teammate.settings;
    for (const a of CONNECT_APPS) {
      expect(en.connectName[a.id], a.id).not.toBe('');
      expect(zh.connectName[a.id], a.id).not.toBe('');
    }
    expect(en.connectName.codex).toBe('Codex app and Codex CLI');
    expect(zh.connectName.codex).toBe('Codex 应用和 Codex CLI');
    expect(zh.connectName['claude-code']).toBe('Claude Code（在 lolPing 之外）');
    for (const name of Object.values(zh.connectName)) {
      expect(name).not.toMatch(/ and |\(|outside|desktop|IDEs|agent mode/);
    }
    expect(en.connectPage.claudeCode).toBe('claude mcp add lolping -- <command>');
    expect(zh.connectPage.claudeCode).toBe('claude mcp add lolping -- <命令>');
  });

  it('names where to add lolPing on every platform', () => {
    for (const a of CONNECT_APPS) {
      expect(a.file !== undefined || a.page !== undefined, a.id).toBe(true);
      if (a.file) for (const p of ['win', 'mac', 'linux'] as const) expect(a.file[p], `${a.id} ${p}`).not.toBe('');
    }
    expect(app('claude-desktop').file).toEqual({
      win: '%APPDATA%\\Claude\\claude_desktop_config.json',
      mac: '~/Library/Application Support/Claude/claude_desktop_config.json',
      linux: '~/.config/Claude/claude_desktop_config.json',
    });
    expect(app('cursor').file?.win).toBe('~/.cursor/mcp.json');
    expect(app('dsh').file?.mac).toBe('~/.dsh/profiles/desktop/cordis.patch.yml');
  });

  it('puts each app on the shape its config file reads', () => {
    const shapeOf = (id: string): ConnectShape => app(id).shape;
    expect(shapeOf('claude-desktop')).toBe('mcpServers');
    expect(shapeOf('codex')).toBe('toml');
    expect(shapeOf('vscode')).toBe('servers');
    expect(shapeOf('zed')).toBe('context_servers');
    expect(shapeOf('dsh')).toBe('dshPatch');
    expect(shapeOf('goose')).toBe('gooseLine');
    expect(shapeOf('claude-code')).toBe('claudeCodeLine');
  });
});

describe('connectSnippet', () => {
  it('writes mcpServers as the JSON the profile card already copies', () => {
    expect(JSON.parse(snip('mcpServers', BRIDGE, 'win'))).toEqual({ mcpServers: { lolping: BRIDGE } });
    expect(snip('mcpServers', BRIDGE, 'mac')).toBe(mcpServersJson(BRIDGE));
  });

  it('writes servers with a stdio type for VS Code', () => {
    expect(JSON.parse(snip('servers', BRIDGE, 'win'))).toEqual({
      servers: { lolping: { type: 'stdio', ...BRIDGE } },
    });
  });

  it('nests the command under a path for Zed', () => {
    expect(JSON.parse(snip('context_servers', BRIDGE, 'win'))).toEqual({
      context_servers: { lolping: { command: { path: BRIDGE.command, args: BRIDGE.args, env: BRIDGE.env } } },
    });
  });

  it('writes a TOML table with strings Codex can read back', () => {
    const toml = snip('toml', BRIDGE, 'win');
    expect(toml).toBe([
      '[mcp_servers.lolping]',
      'command = "C:\\\\Program Files\\\\lolPing\\\\lolPing.exe"',
      'args = ["C:\\\\Program Files\\\\lolPing\\\\resources\\\\out\\\\main\\\\bridge.js"]',
      '',
      '[mcp_servers.lolping.env]',
      'ELECTRON_RUN_AS_NODE = "1"',
      'LOLPING_PIPE = "\\\\\\\\.\\\\pipe\\\\lolping-0123456789abcdef"',
      'LOLPING_DATA = "C:\\\\Users\\\\a b"',
      '',
    ].join('\n'));
    const quoted = snip('toml', { command: 'a"b', args: [], env: {} }, 'linux');
    expect(quoted).toContain('command = "a\\"b"');
    expect(quoted).toContain('args = []');
    expect(quoted).not.toContain('.env]');
  });

  it('writes dsh\'s insert row like the preset does, with quotes doubled', () => {
    const yaml = snip('dshPatch', { ...BRIDGE, args: ['it\'s'] }, 'win');
    const preset = AGENT_PRESETS.dsh.configFile({
      prompt: 'p', askDir: 'd', mcpConfigPath: 'm', bridge: { ...BRIDGE, args: ['it\'s'] }, resume: null,
    }) ?? '';
    expect(yaml).toBe(preset.slice(preset.indexOf('- insert:')));
    expect(yaml.startsWith('- insert:\n')).toBe(true);
    expect(yaml).toContain('          - \'it\'\'s\'');
  });

  it('gives Goose the command line, then the variables to type into its dialog', () => {
    expect(connectSnippet('gooseLine', BRIDGE, 'win', ENV_LABEL)).toBe([
      `'${BRIDGE.command}' '${BRIDGE.args[0]}'`, '', 'Environment variables:',
      'ELECTRON_RUN_AS_NODE=1', String.raw`LOLPING_PIPE=\\.\pipe\lolping-0123456789abcdef`,
      String.raw`LOLPING_DATA=C:\Users\a b`,
    ].join('\n'));
    expect(connectSnippet('gooseLine', { command: 'it\'s', args: [], env: {} }, 'mac', ENV_LABEL))
      .toBe(String.raw`'it'\''s'`);
  });

  it('makes the same mcp add line for another agent\'s own command', () => {
    expect(mcpAddLine('qodercli', BRIDGE, 'win'))
      .toBe(snip('claudeCodeLine', BRIDGE, 'win').replace(/^claude /, 'qodercli '));
    expect(mcpAddLine('qodercli', { command: '/opt/lol Ping', args: ['b.js'], env: { K: 'v w' } }, 'linux'))
      .toBe('qodercli mcp add lolping -e \'K=v w\' -- \'/opt/lol Ping\' b.js');
  });

  it('puts Claude Code\'s env flags before the double dash and quotes for the shell', () => {
    const posix = snip('claudeCodeLine', { ...BRIDGE, command: '/Applications/lol Ping/lolPing' }, 'mac');
    expect(posix).toBe([
      String.raw`claude mcp add lolping -e ELECTRON_RUN_AS_NODE=1 -e 'LOLPING_PIPE=\\.\pipe\lolping-0123456789abcdef'`,
      String.raw`-e 'LOLPING_DATA=C:\Users\a b' --`,
      String.raw`'/Applications/lol Ping/lolPing' 'C:\Program Files\lolPing\resources\out\main\bridge.js'`,
    ].join(' '));
    const win = snip('claudeCodeLine', BRIDGE, 'win');
    expect(win).toBe([
      'claude mcp add lolping -e ELECTRON_RUN_AS_NODE=1 -e LOLPING_PIPE=\\\\.\\pipe\\lolping-0123456789abcdef',
      '-e "LOLPING_DATA=C:\\Users\\a b" --',
      '"C:\\Program Files\\lolPing\\lolPing.exe" "C:\\Program Files\\lolPing\\resources\\out\\main\\bridge.js"',
    ].join(' '));
    expect(snip('claudeCodeLine', { command: 'a', args: ['x"y', 'z \\'], env: {} }, 'win'))
      .toBe('claude mcp add lolping -- a "x\\"y" "z \\\\"');
  });
});

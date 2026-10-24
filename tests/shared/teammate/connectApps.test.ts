import { describe, expect, it } from 'vitest';
import { AGENT_PRESETS } from '../../../src/shared/teammate/agents';
import {
  CONNECT_APPS, connectSnippet, mcpServersJson, type ConnectShape,
} from '../../../src/shared/teammate/connectApps';

const BRIDGE = {
  command: 'C:\\Program Files\\lolPing\\lolPing.exe',
  args: ['C:\\Program Files\\lolPing\\resources\\out\\main\\bridge.js'],
  env: { ELECTRON_RUN_AS_NODE: '1', LOLPING_PIPE: '\\\\.\\pipe\\lolping-0123456789abcdef', LOLPING_DATA: 'C:\\Users\\a b' },
};

const app = (id: string) => {
  const found = CONNECT_APPS.find((a) => a.id === id);
  if (!found) throw new Error(`no app ${id}`);
  return found;
};

describe('CONNECT_APPS', () => {
  it('gives every app a snippet in its own shape', () => {
    const shapes = new Map<ConnectShape, string>();
    for (const a of CONNECT_APPS) {
      const text = connectSnippet(a.shape, BRIDGE, 'win');
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
    expect(JSON.parse(connectSnippet('mcpServers', BRIDGE, 'win'))).toEqual({ mcpServers: { lolping: BRIDGE } });
    expect(connectSnippet('mcpServers', BRIDGE, 'mac')).toBe(mcpServersJson(BRIDGE));
  });

  it('writes servers with a stdio type for VS Code', () => {
    expect(JSON.parse(connectSnippet('servers', BRIDGE, 'win'))).toEqual({
      servers: { lolping: { type: 'stdio', ...BRIDGE } },
    });
  });

  it('nests the command under a path for Zed', () => {
    expect(JSON.parse(connectSnippet('context_servers', BRIDGE, 'win'))).toEqual({
      context_servers: { lolping: { command: { path: BRIDGE.command, args: BRIDGE.args, env: BRIDGE.env } } },
    });
  });

  it('writes a TOML table with strings Codex can read back', () => {
    const toml = connectSnippet('toml', BRIDGE, 'win');
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
    const quoted = connectSnippet('toml', { command: 'a"b', args: [], env: {} }, 'linux');
    expect(quoted).toContain('command = "a\\"b"');
    expect(quoted).toContain('args = []');
    expect(quoted).not.toContain('.env]');
  });

  it('writes dsh\'s insert row like the preset does, with quotes doubled', () => {
    const yaml = connectSnippet('dshPatch', { ...BRIDGE, args: ['it\'s'] }, 'win');
    const preset = AGENT_PRESETS.dsh.configFile({
      prompt: 'p', askDir: 'd', mcpConfigPath: 'm', bridge: { ...BRIDGE, args: ['it\'s'] }, resume: null,
    }) ?? '';
    expect(yaml).toBe(preset.slice(preset.indexOf('- insert:')));
    expect(yaml.startsWith('- insert:\n')).toBe(true);
    expect(yaml).toContain('          - \'it\'\'s\'');
  });

  it('puts Goose\'s variables and parts on one line in single quotes', () => {
    const line = connectSnippet('gooseLine', BRIDGE, 'win');
    expect(line).not.toContain('\n');
    expect(line).toBe([
      '\'ELECTRON_RUN_AS_NODE=1\'', '\'LOLPING_PIPE=\\\\.\\pipe\\lolping-0123456789abcdef\'',
      '\'LOLPING_DATA=C:\\Users\\a b\'', `'${BRIDGE.command}'`, `'${BRIDGE.args[0]}'`,
    ].join(' '));
    expect(connectSnippet('gooseLine', { command: 'it\'s', args: [], env: {} }, 'mac')).toBe('\'it\'\\\'\'s\'');
  });

  it('puts Claude Code\'s env flags before the double dash and quotes for the shell', () => {
    const posix = connectSnippet('claudeCodeLine', { ...BRIDGE, command: '/Applications/lol Ping/lolPing' }, 'mac');
    expect(posix).toBe([
      String.raw`claude mcp add lolping -e ELECTRON_RUN_AS_NODE=1 -e 'LOLPING_PIPE=\\.\pipe\lolping-0123456789abcdef'`,
      String.raw`-e 'LOLPING_DATA=C:\Users\a b' --`,
      String.raw`'/Applications/lol Ping/lolPing' 'C:\Program Files\lolPing\resources\out\main\bridge.js'`,
    ].join(' '));
    const win = connectSnippet('claudeCodeLine', BRIDGE, 'win');
    expect(win).toBe([
      'claude mcp add lolping -e ELECTRON_RUN_AS_NODE=1 -e LOLPING_PIPE=\\\\.\\pipe\\lolping-0123456789abcdef',
      '-e "LOLPING_DATA=C:\\Users\\a b" --',
      '"C:\\Program Files\\lolPing\\lolPing.exe" "C:\\Program Files\\lolPing\\resources\\out\\main\\bridge.js"',
    ].join(' '));
    expect(connectSnippet('claudeCodeLine', { command: 'a', args: ['x"y', 'z \\'], env: {} }, 'win'))
      .toBe('claude mcp add lolping -- a "x\\"y" "z \\\\"');
  });
});

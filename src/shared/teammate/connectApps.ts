import type { Platform } from '../platform';
import { dshInsertRows } from './agents';
import { posixQuote, tomlKey, tomlString } from './quote';

/** How lolPing's bridge starts: the app's executable as Node, with bridge.js. */
export interface BridgeCommand {
  command: string;
  args: string[];
  env: Record<string, string>;
}

/** The text an app wants: the key its MCP file nests servers under, or one of the two command lines. */
export type ConnectShape =
  | 'mcpServers' | 'servers' | 'context_servers' | 'toml' | 'dshPatch' | 'gooseLine' | 'claudeCodeLine';

/** Where an app has no file to name: the settings page, or the command, the settings window describes in words. */
export type ConnectPage =
  | 'vscode' | 'antigravity' | 'theirSettings' | 'jetbrains' | 'extension' | 'goose' | 'cherryLm' | 'claudeCode';

/** The apps by id; the settings window names each in its language (i18n `connectName`), product names as they are. */
export type ConnectAppId =
  | 'claude-desktop' | 'codex' | 'cursor' | 'vscode' | 'windsurf' | 'antigravity' | 'zed' | 'kiro' | 'trae' | 'jetbrains'
  | 'cline' | 'dsh' | 'goose' | 'cherry' | 'gemini' | 'claude-code';

export type ConnectApp = { id: ConnectAppId; shape: ConnectShape } & (
  | { file: Record<Platform, string>; page?: undefined }
  | { page: ConnectPage; file?: undefined }
);

const everywhere = (path: string): Record<Platform, string> => ({ win: path, mac: path, linux: path });

/** The apps lolPing can't start itself, in the order the settings page lists them. lolPing never edits their files. */
export const CONNECT_APPS: readonly ConnectApp[] = [
  {
    id: 'claude-desktop', shape: 'mcpServers',
    file: {
      win: '%APPDATA%\\Claude\\claude_desktop_config.json',
      mac: '~/Library/Application Support/Claude/claude_desktop_config.json',
      linux: '~/.config/Claude/claude_desktop_config.json',
    },
  },
  { id: 'codex', shape: 'toml', file: everywhere('~/.codex/config.toml') },
  { id: 'cursor', shape: 'mcpServers', file: everywhere('~/.cursor/mcp.json') },
  { id: 'vscode', shape: 'servers', page: 'vscode' },
  {
    id: 'windsurf', shape: 'mcpServers',
    file: {
      win: '%APPDATA%\\devin\\mcp_config.json', mac: '~/.config/devin/mcp_config.json',
      linux: '~/.config/devin/mcp_config.json',
    },
  },
  { id: 'antigravity', shape: 'mcpServers', page: 'antigravity' },
  { id: 'zed', shape: 'context_servers', file: everywhere('~/.config/zed/settings.json') },
  { id: 'kiro', shape: 'mcpServers', file: everywhere('~/.kiro/settings/mcp.json') },
  { id: 'trae', shape: 'mcpServers', page: 'theirSettings' },
  { id: 'jetbrains', shape: 'mcpServers', page: 'jetbrains' },
  { id: 'cline', shape: 'mcpServers', page: 'extension' },
  { id: 'dsh', shape: 'dshPatch', file: everywhere('~/.dsh/profiles/desktop/cordis.patch.yml') },
  { id: 'goose', shape: 'gooseLine', page: 'goose' },
  { id: 'cherry', shape: 'mcpServers', page: 'cherryLm' },
  { id: 'gemini', shape: 'mcpServers', file: everywhere('~/.gemini/settings.json, ~/.qwen/settings.json') },
  { id: 'claude-code', shape: 'claudeCodeLine', page: 'claudeCode' },
];

/** The `mcpServers` JSON most MCP clients read; also what an agent profile's Copy snippet gives. */
export function mcpServersJson(b: BridgeCommand): string {
  return JSON.stringify({ mcpServers: { lolping: b } }, null, 2);
}

function tomlTable(b: BridgeCommand): string {
  const env = Object.entries(b.env).map(([k, v]) => `${tomlKey(k)} = ${tomlString(v)}`);
  return [
    '[mcp_servers.lolping]',
    `command = ${tomlString(b.command)}`,
    `args = [${b.args.map(tomlString).join(', ')}]`,
    ...(env.length === 0 ? [] : ['', '[mcp_servers.lolping.env]', ...env]),
    '',
  ].join('\n');
}

/** One word of a command typed into the user's shell: PowerShell and cmd on Windows, a POSIX shell elsewhere. */
function shellWord(platform: Platform, v: string): string {
  if (platform !== 'win') return /^[\w@%+=:,./-]+$/.test(v) ? v : posixQuote(v);
  if (/^[\w@+=:,./\\-]+$/.test(v)) return v;
  // Backslashes double only before a quote, and at the end where the closing quote follows.
  return `"${v.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`;
}

const envPairs = (b: BridgeCommand): string[] => Object.entries(b.env).map(([k, v]) => `${k}=${v}`);

/**
 * The text to copy for an app of the given shape: the bridge command as that app's config or command line wants it.
 * `envLabel` heads the variable lines of Goose's snippet, whose dialog takes them in rows of their own.
 */
export function connectSnippet(shape: ConnectShape, b: BridgeCommand, platform: Platform, envLabel: string): string {
  switch (shape) {
    case 'mcpServers':
      return mcpServersJson(b);
    case 'servers':
      return JSON.stringify({ servers: { lolping: { type: 'stdio', ...b } } }, null, 2);
    case 'context_servers':
      return JSON.stringify(
        { context_servers: { lolping: { command: { path: b.command, args: b.args, env: b.env } } } }, null, 2,
      );
    case 'toml':
      return tomlTable(b);
    case 'dshPatch':
      return [...dshInsertRows(b), ''].join('\n');
    case 'gooseLine': {
      // Goose splits the command field shell-style on every platform; single quotes keep Windows backslashes.
      const vars = envPairs(b);
      return [[b.command, ...b.args].map(posixQuote).join(' '), ...(vars.length > 0 ? ['', envLabel, ...vars] : [])]
        .join('\n');
    }
    case 'claudeCodeLine':
      return mcpAddLine('claude', b, platform);
  }
}

/** `<bin> mcp add lolping -e K=V … -- <command> <args…>`, quoted for the user's shell: Claude Code's and Qoder's. */
export function mcpAddLine(bin: string, b: BridgeCommand, platform: Platform): string {
  return [
    `${bin} mcp add lolping`, ...envPairs(b).map((pair) => `-e ${shellWord(platform, pair)}`), '--',
    ...[b.command, ...b.args].map((w) => shellWord(platform, w)),
  ].join(' ');
}

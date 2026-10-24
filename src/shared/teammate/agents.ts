import { posixQuote, tomlKey, tomlString } from './quote';

export const AGENT_PRESET_IDS = [
  'claude', 'dsh', 'codex', 'gemini', 'qwen', 'copilot', 'cursor', 'opencode', 'kimi', 'auggie', 'goose', 'droid',
  'qoder', 'kiro',
] as const;
export type AgentPresetId = (typeof AGENT_PRESET_IDS)[number];

/** What lolPing generates for one run; every path is absolute. */
export interface AgentRunSpec {
  prompt: string;
  askDir: string;
  mcpConfigPath: string;
  bridge: { command: string; args: string[]; env: Record<string, string> };
  resume: string | null;
}

export interface AgentParsed { session?: string; error?: string }

export interface AgentPreset {
  id: AgentPresetId;
  /** Product name, the same in every language. */
  name: string;
  bin: string;
  checked: boolean;
  /** Claude Code only: permission prompts come to lolPing's `consent` tool. */
  consent: boolean;
  /** How the agent learns about lolPing's bridge: flags or a generated file per run, or the user adds lolPing to the
   *  agent's own MCP config once (the profile card shows the snippet and the file); then LOLPING_ASK reaches the
   *  bridge through the agent's environment. */
  mcp: 'run' | 'user';
  /** Where the user adds lolPing for `mcp: 'user'`, e.g. '~/.cursor/mcp.json'. */
  userConfig?: string;
  /** The approval note on the card: 'asks' (consent cards), 'own' (its own approval settings), 'none' (edits freely). */
  approvals: 'asks' | 'own' | 'none';
  args(s: AgentRunSpec): string[];
  /** The MCP config file lolPing writes to s.mcpConfigPath (JSON, TOML or YAML text), or null when args carry it. */
  configFile(s: AgentRunSpec): string | null;
  /** Extra environment for the agent process (e.g. a settings-file path). */
  env(s: AgentRunSpec): Record<string, string>;
  /** One stdout line → a session id, the final error text, or nothing. */
  parse(line: string): AgentParsed;
  /** argv to continue a session in a terminal. */
  openArgs(session: string): string[];
}

/** Text in an MCP client's own name (what it sends in `initialize`) and the preset it marks. */
const CLIENT_MARKS: ReadonlyArray<readonly [string, AgentPresetId]> = [
  ['claude-code', 'claude'], ['dsh-mcp-client', 'dsh'], ['codex', 'codex'], ['gemini', 'gemini'], ['qwen', 'qwen'],
  ['copilot', 'copilot'], ['cursor', 'cursor'], ['opencode', 'opencode'], ['kimi', 'kimi'], ['auggie', 'auggie'],
  ['goose', 'goose'], ['droid', 'droid'], ['factory', 'droid'], ['qoder', 'qoder'], ['kiro', 'kiro'],
];

/** The preset an MCP client belongs to, or null for an app that isn't one of them. */
export function presetForClient(name: string): AgentPresetId | null {
  const n = name.toLowerCase();
  return CLIENT_MARKS.find(([mark]) => n.includes(mark))?.[1] ?? null;
}

/** The tools lolPing offers an agent without asking: the display tools. */
export const DISPLAY_TOOLS = ['say', 'ping', 'emote', 'answer'] as const;

/** The one prompt line; everything else about the ask is in the files in askDir. */
export function agentPrompt(askDir: string): string {
  return `lolPing asks you something. Read ask.md in ${askDir}, look at the images it names, and answer only with the `
    + 'lolping tools.';
}

type Json = Record<string, unknown>;

function jsonLine(line: string): Json | null {
  const text = line.trim();
  if (!text.startsWith('{')) return null;
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Json : null;
  } catch {
    return null;
  }
}

function text(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined;
}

function obj(v: unknown): Json {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? v as Json : {};
}

/** Builds the result without keys that have no value, so `{}` means "nothing on this line". */
function parsed(session: string | undefined, error?: string): AgentParsed {
  return {
    ...(session !== undefined ? { session } : {}),
    ...(error !== undefined ? { error } : {}),
  };
}

/** For agents whose stream-json lines each carry `session_id`. */
function sessionIdLine(line: string): AgentParsed {
  const o = jsonLine(line);
  return o ? parsed(text(o.session_id)) : {};
}

/** Gemini CLI and Qwen Code print the id once, on their init line. */
function initLine(line: string): AgentParsed {
  const o = jsonLine(line);
  return o && (o.type === 'init' || o.subtype === 'init') ? parsed(text(o.session_id)) : {};
}

const noParse = (): AgentParsed => ({});
const noEnv = (): Record<string, string> => ({});
const noConfig = (): string | null => null;

/** Claude's `mcpServers` file, also read by Copilot CLI, Kimi Code and Auggie. */
function stdioConfig(s: AgentRunSpec, extra: Json = {}): string {
  return JSON.stringify({
    mcpServers: {
      lolping: { type: 'stdio', command: s.bridge.command, args: s.bridge.args, env: s.bridge.env, ...extra },
    },
  });
}

/** Gemini CLI and Qwen Code settings: the same table without a transport type. */
function settingsConfig(s: AgentRunSpec): string {
  return JSON.stringify({
    mcpServers: { lolping: { command: s.bridge.command, args: s.bridge.args, env: s.bridge.env } },
  });
}

const withResume = (s: AgentRunSpec, flag: string[]): string[] => (s.resume === null ? [] : [...flag, s.resume]);

function tomlTable(env: Record<string, string>): string {
  const pairs = Object.entries(env).map(([k, v]) => `${tomlKey(k)} = ${tomlString(v)}`);
  return pairs.length === 0 ? '{}' : `{ ${pairs.join(', ')} }`;
}

const yamlString = (v: string): string => `'${v.replace(/'/g, '\'\'')}'`;

/** The `- insert:` row that adds the bridge to dsh as an MCP server; also what the user adds to dsh's own patch. */
export function dshInsertRows(bridge: AgentRunSpec['bridge']): string[] {
  const args = bridge.args.length === 0
    ? ['        args: []']
    : ['        args:', ...bridge.args.map((a) => `          - ${yamlString(a)}`)];
  const env = Object.entries(bridge.env);
  const envRows = env.length === 0
    ? ['        env: {}']
    : ['        env:', ...env.map(([k, v]) => `          ${yamlString(k)}: ${yamlString(v)}`)];
  return [
    '- insert:',
    '    - id: \'mcp-lolping\'',
    '      name: \'@deepseek-ai/dsh-mcp-client\'',
    '      config:',
    '        serverName: \'lolping\'',
    '        transport: \'stdio\'',
    `        command: ${yamlString(bridge.command)}`,
    ...args,
    ...envRows,
  ];
}

/** dsh's `--patch` overlay: the three credential plugins headless turns off, then the bridge as a new MCP server. */
function dshPatch(s: AgentRunSpec): string {
  const rows = ['credentials', 'authorization', 'deepseek-account'].flatMap((id) => [
    `- id: ${yamlString(id)}`, '  disabled: false',
  ]);
  return [...rows, ...dshInsertRows(s.bridge), ''].join('\n');
}

// lolPing's own actions ask the user in lolPing (a copy only fills the clipboard), so Claude Code's card would be a
// second one. Never consent: that is the prompt itself.
const CLAUDE_TOOLS = [...DISPLAY_TOOLS, 'look', 'read_file', 'copy', 'paste', 'fill', 'event', 'open']
  .map((t) => `mcp__lolping__${t}`).join(',');

function claudeParse(line: string): AgentParsed {
  const o = jsonLine(line);
  if (!o) return {};
  const failed = o.type === 'result' && o.is_error === true;
  const error = failed ? text(o.result) ?? text(o.subtype) ?? 'error' : undefined;
  return parsed(text(o.session_id), error);
}

function codexParse(line: string): AgentParsed {
  const o = jsonLine(line);
  if (!o) return {};
  switch (o.type) {
    case 'thread.started': return parsed(text(o.thread_id));
    case 'error': return parsed(undefined, text(o.message));
    case 'turn.failed': return parsed(undefined, text(obj(o.error).message) ?? 'error');
    default: return {};
  }
}

function dshParse(line: string): AgentParsed {
  const o = jsonLine(line);
  if (!o) return {};
  if (o.type === 'session') return parsed(text(o.sessionId));
  if (o.type === 'error') return parsed(undefined, text(o.message));
  if (o.type === 'turn_end') {
    const reason = obj(o.reason);
    if (reason.kind === 'error') return parsed(undefined, text(reason.message) ?? 'error');
  }
  return {};
}

function opencodeParse(line: string): AgentParsed {
  const o = jsonLine(line);
  return o ? parsed(text(o.sessionID)) : {};
}

const STREAM_JSON = ['--output-format', 'stream-json'];

export const AGENT_PRESETS: Readonly<Record<AgentPresetId, AgentPreset>> = {
  claude: {
    id: 'claude', name: 'Claude Code', bin: 'claude', checked: true, consent: true, mcp: 'run', approvals: 'asks',
    args: (s) => [
      '-p', s.prompt, '--mcp-config', s.mcpConfigPath, '--strict-mcp-config', '--add-dir', s.askDir,
      '--allowedTools', CLAUDE_TOOLS, '--permission-prompt-tool', 'mcp__lolping__consent', ...STREAM_JSON, '--verbose',
      ...withResume(s, ['--resume']),
    ],
    configFile: (s) => stdioConfig(s),
    env: noEnv,
    parse: claudeParse,
    openArgs: (id) => ['--resume', id],
  },
  dsh: {
    id: 'dsh', name: 'DeepSeek Harness', bin: 'dsh', checked: true, consent: false, mcp: 'run', approvals: 'none',
    args: (s) => [
      '--profile', 'headless', '--json', '--patch', s.mcpConfigPath, ...withResume(s, ['--session-id']), s.prompt,
    ],
    configFile: dshPatch,
    env: noEnv,
    parse: dshParse,
    openArgs: (id) => ['tui', '--resume', id],
  },
  codex: {
    id: 'codex', name: 'Codex', bin: 'codex', checked: false, consent: false, mcp: 'run', approvals: 'own',
    // Codex has no config-file flag, so the bridge goes in as -c overrides; options come before `resume`.
    args: (s) => [
      'exec', '--json', '--skip-git-repo-check',
      '-c', `mcp_servers.lolping.command=${tomlString(s.bridge.command)}`,
      '-c', `mcp_servers.lolping.args=${JSON.stringify(s.bridge.args)}`,
      '-c', `mcp_servers.lolping.env=${tomlTable(s.bridge.env)}`,
      ...(s.resume === null ? [] : ['resume', s.resume]), s.prompt,
    ],
    configFile: noConfig,
    env: noEnv,
    parse: codexParse,
    openArgs: (id) => ['resume', id],
  },
  gemini: {
    id: 'gemini', name: 'Gemini CLI', bin: 'gemini', checked: false, consent: false, mcp: 'run', approvals: 'own',
    args: (s) => ['-p', s.prompt, ...STREAM_JSON, ...withResume(s, ['--resume'])],
    configFile: settingsConfig,
    env: (s) => ({ GEMINI_CLI_SYSTEM_SETTINGS_PATH: s.mcpConfigPath }),
    parse: initLine,
    openArgs: (id) => ['--resume', id],
  },
  qwen: {
    id: 'qwen', name: 'Qwen Code', bin: 'qwen', checked: false, consent: false, mcp: 'run', approvals: 'own',
    args: (s) => ['-p', s.prompt, ...STREAM_JSON, ...withResume(s, ['--resume'])],
    configFile: settingsConfig,
    env: (s) => ({ QWEN_CODE_SYSTEM_SETTINGS_PATH: s.mcpConfigPath }),
    parse: initLine,
    openArgs: (id) => ['--resume', id],
  },
  copilot: {
    id: 'copilot', name: 'Copilot CLI', bin: 'copilot', checked: false, consent: false, mcp: 'run', approvals: 'own',
    args: (s) => [
      '-p', s.prompt, '--additional-mcp-config', `@${s.mcpConfigPath}`, '--allow-tool', 'lolping',
      ...withResume(s, ['--resume']),
    ],
    // Copilot CLI wants an explicit tool list on each server.
    configFile: (s) => stdioConfig(s, { tools: ['*'] }),
    env: noEnv,
    parse: noParse,
    openArgs: (id) => ['--resume', id],
  },
  cursor: {
    id: 'cursor', name: 'Cursor CLI', bin: 'cursor-agent', checked: false, consent: false, mcp: 'user',
    userConfig: '~/.cursor/mcp.json', approvals: 'own',
    args: (s) => ['-p', s.prompt, ...STREAM_JSON, ...withResume(s, ['--resume'])],
    configFile: noConfig,
    env: noEnv,
    parse: sessionIdLine,
    openArgs: (id) => ['--resume', id],
  },
  opencode: {
    id: 'opencode', name: 'opencode', bin: 'opencode', checked: false, consent: false, mcp: 'run', approvals: 'own',
    args: (s) => ['run', s.prompt, '--format', 'json', ...withResume(s, ['--session'])],
    configFile: (s) => JSON.stringify({
      mcp: { lolping: { type: 'local', command: [s.bridge.command, ...s.bridge.args], environment: s.bridge.env } },
    }),
    env: (s) => ({ OPENCODE_CONFIG: s.mcpConfigPath }),
    parse: opencodeParse,
    openArgs: (id) => ['--session', id],
  },
  kimi: {
    id: 'kimi', name: 'Kimi Code', bin: 'kimi', checked: false, consent: false, mcp: 'run', approvals: 'own',
    args: (s) => ['--print', '-c', s.prompt, '--mcp-config-file', s.mcpConfigPath, ...withResume(s, ['-r'])],
    configFile: (s) => stdioConfig(s),
    env: noEnv,
    parse: noParse,
    openArgs: (id) => ['-r', id],
  },
  auggie: {
    id: 'auggie', name: 'Auggie', bin: 'auggie', checked: false, consent: false, mcp: 'run', approvals: 'own',
    args: (s) => ['--print', '--quiet', s.prompt, '--mcp-config', s.mcpConfigPath],
    configFile: (s) => stdioConfig(s),
    env: noEnv,
    parse: noParse,
    openArgs: () => [],
  },
  goose: {
    id: 'goose', name: 'Goose', bin: 'goose', checked: false, consent: false, mcp: 'run', approvals: 'own',
    // Goose can't take env through a config, so its extension line carries the bridge's as leading NAME=value words.
    args: (s) => [
      'run', '-t', s.prompt, '--with-extension', [
        // Goose reads the extension as one shell-style line; single quotes keep Windows backslashes as they are.
        ...Object.entries(s.bridge.env).map(([k, v]) => `${k}=${posixQuote(v)}`),
        ...[s.bridge.command, ...s.bridge.args].map(posixQuote),
      ].join(' '),
      ...(s.resume === null ? [] : ['-r', '--session-id', s.resume]),
    ],
    configFile: noConfig,
    env: noEnv,
    parse: noParse,
    openArgs: (id) => ['session', '-r', '--session-id', id],
  },
  droid: {
    id: 'droid', name: 'Droid', bin: 'droid', checked: false, consent: false, mcp: 'user',
    userConfig: '~/.factory/mcp.json', approvals: 'own',
    args: (s) => ['exec', '-o', 'stream-json', ...withResume(s, ['-s']), s.prompt],
    configFile: noConfig,
    env: noEnv,
    parse: sessionIdLine,
    openArgs: (id) => ['--resume', id],
  },
  qoder: {
    id: 'qoder', name: 'Qoder CLI', bin: 'qodercli', checked: false, consent: false, mcp: 'user', approvals: 'own',
    args: (s) => ['-p', s.prompt, ...STREAM_JSON],
    configFile: noConfig,
    env: noEnv,
    parse: noParse,
    openArgs: (id) => ['--resume', id],
  },
  kiro: {
    id: 'kiro', name: 'Kiro CLI', bin: 'kiro-cli', checked: false, consent: false, mcp: 'user',
    userConfig: '~/.kiro/settings/mcp.json', approvals: 'own',
    args: (s) => ['chat', '--no-interactive', ...withResume(s, ['--resume-id']), s.prompt],
    configFile: noConfig,
    env: noEnv,
    parse: noParse,
    openArgs: (id) => ['chat', '--resume-id', id],
  },
};

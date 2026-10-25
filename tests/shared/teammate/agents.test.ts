import { describe, expect, it } from 'vitest';
import {
  AGENT_PRESET_IDS, AGENT_PRESETS, agentPrompt, DISPLAY_TOOLS, presetForClient, type AgentPresetId, type AgentRunSpec,
} from '../../../src/shared/teammate/agents';

const ASK_DIR = 'C:\\a b&c';
const BRIDGE = {
  command: 'C:\\Program Files\\lolPing\\lolPing.exe',
  args: ['--mcp-bridge', 'it\'s'],
  env: { LOLPING_ASK: 'ask-1', LOLPING_PIPE: '\\\\.\\pipe\\lolping-0123456789abcdef' },
};

function spec(over: Partial<AgentRunSpec> = {}): AgentRunSpec {
  return {
    prompt: agentPrompt(ASK_DIR), askDir: ASK_DIR, mcpConfigPath: 'C:\\Users\\me\\run 1\\mcp.json', bridge: BRIDGE,
    resume: null, ...over,
  };
}

function parseJson(text: string | null): unknown {
  if (text === null) throw new Error('no config file');
  return JSON.parse(text);
}

// Just enough TOML for the values `-c` carries: a basic string, an array of them, an inline table of them.
function parseTomlValue(text: string): unknown {
  if (text.startsWith('"') || text.startsWith('[')) return JSON.parse(text);
  const m = /^\{ (.*) \}$/.exec(text);
  if (!m) throw new Error(`not a TOML value: ${text}`);
  const table: Record<string, string> = {};
  for (const pair of m[1].split(/, (?=(?:[A-Za-z0-9_-]+|"(?:[^"\\]|\\.)*") = ")/)) {
    const eq = /^([A-Za-z0-9_-]+|"(?:[^"\\]|\\.)*") = ("(?:[^"\\]|\\.)*")$/.exec(pair);
    if (!eq) throw new Error(`not a TOML pair: ${pair}`);
    const key: unknown = eq[1].startsWith('"') ? JSON.parse(eq[1]) : eq[1];
    table[String(key)] = String(JSON.parse(eq[2]));
  }
  return table;
}

// Reads back the one fixed shape dsh's patch has: `key: value` lines, `- ` rows, single-quoted scalars.
function unquote(v: string): string {
  const m = /^'((?:[^']|'')*)'$/.exec(v);
  return m ? m[1].replace(/''/g, '\'') : v;
}

const CLAUDE_ARGV = [
  '-p', agentPrompt(ASK_DIR), '--mcp-config', 'C:\\Users\\me\\run 1\\mcp.json', '--strict-mcp-config',
  '--add-dir', ASK_DIR,
  '--allowedTools',
  'mcp__lolping__say,mcp__lolping__ping,mcp__lolping__emote,mcp__lolping__answer,mcp__lolping__look,'
    + 'mcp__lolping__read_file,mcp__lolping__copy,mcp__lolping__paste,mcp__lolping__fill,mcp__lolping__event,'
    + 'mcp__lolping__open',
  '--permission-prompt-tool', 'mcp__lolping__consent', '--output-format', 'stream-json', '--verbose',
];

describe('agents', () => {
  it('lists the fourteen presets, each under its own id', () => {
    expect(AGENT_PRESET_IDS).toHaveLength(14);
    for (const id of AGENT_PRESET_IDS) expect(AGENT_PRESETS[id].id).toBe(id);
    expect(AGENT_PRESETS.cursor.bin).toBe('cursor-agent');
    expect(AGENT_PRESETS.qoder.bin).toBe('qodercli');
    expect(AGENT_PRESETS.kiro.bin).toBe('kiro-cli');
    expect(DISPLAY_TOOLS).toEqual(['say', 'ping', 'emote', 'answer']);
  });

  it('builds Claude Code\'s argv exactly as the spike found', () => {
    expect(AGENT_PRESETS.claude.args(spec())).toEqual(CLAUDE_ARGV);
    expect(AGENT_PRESETS.claude.args(spec({ resume: 'sess-9' }))).toEqual([...CLAUDE_ARGV, '--resume', 'sess-9']);
    expect(AGENT_PRESETS.claude.openArgs('sess-9')).toEqual(['--resume', 'sess-9']);
    expect(AGENT_PRESETS.claude).toMatchObject({ consent: true, approvals: 'asks', mcp: 'run' });
  });

  it('writes dsh\'s patch with the insert row and the credential rows', () => {
    const preset = AGENT_PRESETS.dsh;
    const yaml = preset.configFile(spec());
    expect(yaml).toBe([
      '- id: \'credentials\'',
      '  disabled: false',
      '- id: \'authorization\'',
      '  disabled: false',
      '- id: \'deepseek-account\'',
      '  disabled: false',
      '- insert:',
      '    - id: \'mcp-lolping\'',
      '      name: \'@deepseek-ai/dsh-mcp-client\'',
      '      config:',
      '        serverName: \'lolping\'',
      '        transport: \'stdio\'',
      '        command: \'C:\\Program Files\\lolPing\\lolPing.exe\'',
      '        args:',
      '          - \'--mcp-bridge\'',
      '          - \'it\'\'s\'',
      '        env:',
      '          \'LOLPING_ASK\': \'ask-1\'',
      '          \'LOLPING_PIPE\': \'\\\\.\\pipe\\lolping-0123456789abcdef\'',
      '',
    ].join('\n'));
    const lines = (yaml ?? '').split('\n');
    expect(lines.filter((l) => l.startsWith('- insert:'))).toHaveLength(1);
    const at = (key: string): string => {
      const row = lines.find((l) => l.trim().startsWith(`${key}: `)) ?? '';
      return unquote(row.split(': ').slice(1).join(': '));
    };
    expect(at('serverName')).toBe('lolping');
    expect(at('command')).toBe(BRIDGE.command);
    expect(lines.filter((l) => l.startsWith('          - ')).map((l) => unquote(l.slice(12)))).toEqual(BRIDGE.args);
    expect(lines.some((l) => unquote(l.trim().split(': ')[0]) === 'LOLPING_ASK')).toBe(true);
    expect(preset.configFile(spec({ bridge: { command: 'x', args: [], env: {} } }))).toContain('args: []\n        env: {}\n');
    expect(preset.args(spec())).toEqual([
      '--profile', 'headless', '--json', '--patch', 'C:\\Users\\me\\run 1\\mcp.json', agentPrompt(ASK_DIR),
    ]);
    expect(preset.args(spec({ resume: 's1' }))).toEqual([
      '--profile', 'headless', '--json', '--patch', 'C:\\Users\\me\\run 1\\mcp.json', '--session-id', 's1',
      agentPrompt(ASK_DIR),
    ]);
    expect(preset.openArgs('s1')).toEqual(['tui', '--resume', 's1']);
    expect(preset).toMatchObject({ consent: false, approvals: 'none', mcp: 'run' });
  });

  it('reads dsh\'s session event and its missing-credential failure', () => {
    const parse = AGENT_PRESETS.dsh.parse;
    expect(parse('{"type":"session","sessionId":"d-1","cwd":"C:\\\\work"}')).toEqual({ session: 'd-1' });
    expect(parse('{"type":"text","text":"hi"}')).toEqual({});
    expect(parse('{"type":"error","message":"dsh: MISSING_CREDENTIAL: llm-deepseek: no API key"}')).toEqual({
      error: 'dsh: MISSING_CREDENTIAL: llm-deepseek: no API key',
    });
    expect(parse('{"type":"turn_end","reason":{"kind":"error","message":"no API key"}}')).toEqual({ error: 'no API key' });
    expect(parse('{"type":"turn_end","reason":{"kind":"error"}}')).toEqual({ error: 'error' });
    expect(parse('{"type":"turn_end","reason":{"kind":"done"}}')).toEqual({});
    expect(parse('not json')).toEqual({});
  });

  it('reads Claude Code\'s session id and its not-logged-in result', () => {
    const parse = AGENT_PRESETS.claude.parse;
    expect(parse('{"type":"system","subtype":"init","session_id":"c-1","tools":[]}')).toEqual({ session: 'c-1' });
    expect(parse('{"type":"assistant","message":{}}')).toEqual({});
    const failed = '{"type":"result","subtype":"success","is_error":true,"result":"Not logged in \\u00b7 Please run /login",'
      + '"session_id":"c-2","terminal_reason":"api_error"}';
    expect(parse(failed)).toEqual({ session: 'c-2', error: 'Not logged in \u00b7 Please run /login' });
    expect(parse('{"type":"result","is_error":false,"result":"ok","session_id":"c-3"}')).toEqual({
      session: 'c-3',
    });
    expect(parse('')).toEqual({});
  });

  it('writes the bridge into each preset\'s config shape', () => {
    const stdio = { type: 'stdio', command: BRIDGE.command, args: BRIDGE.args, env: BRIDGE.env };
    expect(parseJson(AGENT_PRESETS.claude.configFile(spec()))).toEqual({ mcpServers: { lolping: stdio } });
    expect(parseJson(AGENT_PRESETS.kimi.configFile(spec()))).toEqual({ mcpServers: { lolping: stdio } });
    expect(parseJson(AGENT_PRESETS.auggie.configFile(spec()))).toEqual({ mcpServers: { lolping: stdio } });
    expect(parseJson(AGENT_PRESETS.copilot.configFile(spec()))).toMatchObject({ mcpServers: { lolping: stdio } });
    const plain = { command: BRIDGE.command, args: BRIDGE.args, env: BRIDGE.env };
    expect(parseJson(AGENT_PRESETS.gemini.configFile(spec()))).toEqual({ mcpServers: { lolping: plain } });
    expect(parseJson(AGENT_PRESETS.qwen.configFile(spec()))).toEqual({ mcpServers: { lolping: plain } });
    expect(parseJson(AGENT_PRESETS.opencode.configFile(spec()))).toEqual({
      mcp: { lolping: { type: 'local', command: [BRIDGE.command, ...BRIDGE.args], environment: BRIDGE.env } },
    });
    const opencode = parseJson(AGENT_PRESETS.opencode.configFile(spec())) as { mcp: { lolping: { command: string[] } } };
    expect(opencode.mcp.lolping.command[0]).toBe(BRIDGE.command);

    const codex = AGENT_PRESETS.codex.args(spec());
    const cValues = new Map<string, unknown>();
    codex.forEach((arg, i) => {
      if (codex[i - 1] !== '-c') return;
      const eq = arg.indexOf('=');
      cValues.set(arg.slice(0, eq), parseTomlValue(arg.slice(eq + 1)));
    });
    expect(Object.fromEntries(cValues)).toEqual({
      'mcp_servers.lolping.command': BRIDGE.command,
      'mcp_servers.lolping.args': BRIDGE.args,
      'mcp_servers.lolping.env': BRIDGE.env,
    });
    expect(AGENT_PRESETS.codex.configFile(spec())).toBeNull();
  });

  it('points each preset at its generated file the way the agent expects', () => {
    const cfg = spec().mcpConfigPath;
    expect(AGENT_PRESETS.gemini.env(spec())).toEqual({ GEMINI_CLI_SYSTEM_SETTINGS_PATH: cfg });
    expect(AGENT_PRESETS.qwen.env(spec())).toEqual({ QWEN_CODE_SYSTEM_SETTINGS_PATH: cfg });
    expect(AGENT_PRESETS.opencode.env(spec())).toEqual({ OPENCODE_CONFIG: cfg });
    expect(AGENT_PRESETS.copilot.args(spec())).toContain(`@${cfg}`);
    expect(AGENT_PRESETS.kimi.args(spec())).toEqual(
      expect.arrayContaining(['--mcp-config-file', cfg]),
    );
    expect(AGENT_PRESETS.auggie.args(spec())).toEqual(expect.arrayContaining(['--mcp-config', cfg]));
  });

  it('builds each unchecked preset\'s argv, with and without resume', () => {
    const p = agentPrompt(ASK_DIR);
    const cfg = spec().mcpConfigPath;
    const argv = (id: AgentPresetId, resume: string | null): string[] => AGENT_PRESETS[id].args(spec({ resume }));
    expect(argv('gemini', null)).toEqual(['-p', p, '--output-format', 'stream-json']);
    expect(argv('gemini', 'g1')).toEqual(['-p', p, '--output-format', 'stream-json', '--resume', 'g1']);
    expect(argv('qwen', 'q1')).toEqual(['-p', p, '--output-format', 'stream-json', '--resume', 'q1']);
    expect(argv('copilot', null)).toEqual(['-p', p, '--additional-mcp-config', `@${cfg}`, '--allow-tool', 'lolping']);
    expect(argv('copilot', 'c1').slice(-2)).toEqual(['--resume', 'c1']);
    expect(argv('cursor', null)).toEqual(['-p', p, '--output-format', 'stream-json']);
    expect(argv('cursor', 'u1').slice(-2)).toEqual(['--resume', 'u1']);
    expect(argv('opencode', null)).toEqual(['run', p, '--format', 'json']);
    expect(argv('opencode', 'o1')).toEqual(['run', p, '--format', 'json', '--session', 'o1']);
    expect(argv('kimi', null)).toEqual(['--print', '-c', p, '--mcp-config-file', cfg]);
    expect(argv('kimi', 'k1').slice(-2)).toEqual(['-r', 'k1']);
    expect(argv('auggie', null)).toEqual(['--print', '--quiet', p, '--mcp-config', cfg]);
    expect(argv('auggie', 'a1')).toEqual(argv('auggie', null));
    expect(argv('droid', null)).toEqual(['exec', '-o', 'stream-json', p]);
    expect(argv('droid', 'd1')).toEqual(['exec', '-o', 'stream-json', '-s', 'd1', p]);
    expect(argv('qoder', null)).toEqual(['-p', p, '--output-format', 'stream-json']);
    expect(argv('kiro', null)).toEqual(['chat', '--no-interactive', p]);
    expect(argv('kiro', 'r1')).toEqual(['chat', '--no-interactive', '--resume-id', 'r1', p]);
    const codex = argv('codex', null);
    expect(codex.slice(0, 3)).toEqual(['exec', '--json', '--skip-git-repo-check']);
    expect(codex[codex.length - 1]).toBe(p);
    const resumed = argv('codex', 'x1');
    expect(resumed.slice(-3)).toEqual(['resume', 'x1', p]);
    expect(resumed.slice(0, 3)).toEqual(['exec', '--json', '--skip-git-repo-check']);
    expect(resumed.filter((a) => a.startsWith('mcp_servers.lolping.'))).toHaveLength(3);
  });

  it('gives goose the bridge as one quoted command line, led by the bridge\'s environment as NAME=value words', () => {
    const bridge = { ...BRIDGE, env: { ELECTRON_RUN_AS_NODE: '1', ...BRIDGE.env, LOLPING_DATA: 'C:\\a b\'s' } };
    const argv = AGENT_PRESETS.goose.args(spec({ bridge }));
    expect(argv.slice(0, 3)).toEqual(['run', '-t', agentPrompt(ASK_DIR)]);
    expect(argv[3]).toBe('--with-extension');
    expect(argv[4]).toBe([
      'ELECTRON_RUN_AS_NODE=\'1\'', 'LOLPING_ASK=\'ask-1\'', 'LOLPING_PIPE=\'\\\\.\\pipe\\lolping-0123456789abcdef\'',
      'LOLPING_DATA=\'C:\\a b\'\\\'\'s\'',
      '\'C:\\Program Files\\lolPing\\lolPing.exe\'', '\'--mcp-bridge\'', '\'it\'\\\'\'s\'',
    ].join(' '));
    expect(argv).toHaveLength(5);
    expect(AGENT_PRESETS.goose.args(spec({ resume: 'g1' })).slice(5)).toEqual(['-r', '--session-id', 'g1']);
    expect(AGENT_PRESETS.goose.configFile(spec())).toBeNull();
    expect(AGENT_PRESETS.goose.env(spec())).toEqual({});
  });

  it('leaves the MCP setup to the user for agents that only read their own config', () => {
    const users: [AgentPresetId, string | undefined][] = [
      ['cursor', '~/.cursor/mcp.json'], ['droid', '~/.factory/mcp.json'], ['qoder', undefined],
      ['kiro', '~/.kiro/settings/mcp.json'],
    ];
    for (const [id, userConfig] of users) {
      const p = AGENT_PRESETS[id];
      expect(p.mcp, id).toBe('user');
      expect(p.userConfig, id).toBe(userConfig);
      expect(p.configFile(spec()), id).toBeNull();
      expect(p.env(spec()), id).toEqual({});
      expect(p.args(spec()).join(' '), id).not.toMatch(/mcp/i);
    }
    for (const id of AGENT_PRESET_IDS) {
      if (!users.some(([u]) => u === id)) expect(AGENT_PRESETS[id].mcp, id).toBe('run');
    }
  });

  it('reads session ids from the agents that print them', () => {
    expect(AGENT_PRESETS.codex.parse('{"type":"thread.started","thread_id":"t-1"}')).toEqual({ session: 't-1' });
    expect(AGENT_PRESETS.codex.parse('{"type":"error","message":"boom"}')).toEqual({ error: 'boom' });
    expect(AGENT_PRESETS.codex.parse('{"type":"turn.failed","error":{"message":"quota"}}')).toEqual({
      error: 'quota',
    });
    expect(AGENT_PRESETS.codex.parse('{"type":"turn.completed","usage":{}}')).toEqual({});
    expect(AGENT_PRESETS.gemini.parse('{"type":"init","session_id":"g-1","model":"m"}')).toEqual({ session: 'g-1' });
    expect(AGENT_PRESETS.gemini.parse('{"type":"message","session_id":"g-2"}')).toEqual({});
    expect(AGENT_PRESETS.qwen.parse('{"type":"system","subtype":"init","session_id":"w-1"}')).toEqual({ session: 'w-1' });
    expect(AGENT_PRESETS.cursor.parse('{"type":"system","session_id":"u-1"}')).toEqual({ session: 'u-1' });
    expect(AGENT_PRESETS.droid.parse('{"type":"system","session_id":"d-1"}')).toEqual({ session: 'd-1' });
    expect(AGENT_PRESETS.opencode.parse('{"type":"step_start","sessionID":"ses_1"}')).toEqual({ session: 'ses_1' });
    for (const id of ['copilot', 'kimi', 'auggie', 'goose', 'qoder', 'kiro'] as const) {
      expect(AGENT_PRESETS[id].parse('{"type":"x","session_id":"s","sessionId":"s"}'), id).toEqual({});
    }
  });

  it('continues a session in a terminal the way each agent says', () => {
    const open = (id: AgentPresetId): string[] => AGENT_PRESETS[id].openArgs('S');
    expect(open('codex')).toEqual(['resume', 'S']);
    expect(open('gemini')).toEqual(['--resume', 'S']);
    expect(open('qwen')).toEqual(['--resume', 'S']);
    expect(open('cursor')).toEqual(['--resume', 'S']);
    expect(open('opencode')).toEqual(['--session', 'S']);
    expect(open('kimi')).toEqual(['-r', 'S']);
    expect(open('goose')).toEqual(['session', '-r', '--session-id', 'S']);
    expect(open('kiro')).toEqual(['chat', '--resume-id', 'S']);
  });

  it('never puts anything but the fixed prompt line and lolPing paths in argv', () => {
    const fixed = new Set([
      'exec', 'run', 'chat', 'resume', 'tui', 'lolping', 'stream-json', 'json', 'headless', 'session',
    ]);
    for (const resume of [null, 'sess 1']) {
      const s = spec({ resume });
      const allowed = new Set<string>([
        s.prompt, s.askDir, s.mcpConfigPath, `@${s.mcpConfigPath}`, s.bridge.command, ...s.bridge.args,
        ...(resume === null ? [] : [resume]),
      ]);
      for (const id of AGENT_PRESET_IDS) {
        for (const arg of AGENT_PRESETS[id].args(s)) {
          const ok = allowed.has(arg) || fixed.has(arg) || arg.startsWith('-') || arg.startsWith('mcp_servers.lolping.')
            || arg.startsWith('mcp__lolping__') || arg.includes(s.bridge.command);
          expect(ok, `${id}: ${arg}`).toBe(true);
          if (arg.includes('a b&c')) expect(arg === s.prompt || arg === s.askDir, `${id}: ${arg}`).toBe(true);
        }
      }
    }
    expect(agentPrompt(ASK_DIR)).toBe(
      'lolPing asks you something. Read ask.md in C:\\a b&c, look at the images it names, and answer only with the '
        + 'lolping tools.',
    );
  });

  it('marks only Claude Code and dsh as checked', () => {
    expect(AGENT_PRESET_IDS.filter((id) => AGENT_PRESETS[id].checked)).toEqual(['claude', 'dsh']);
    expect(AGENT_PRESET_IDS.filter((id) => AGENT_PRESETS[id].consent)).toEqual(['claude']);
    expect(AGENT_PRESET_IDS.filter((id) => AGENT_PRESETS[id].approvals === 'asks')).toEqual(['claude']);
    expect(AGENT_PRESET_IDS.filter((id) => AGENT_PRESETS[id].approvals === 'none')).toEqual(['dsh']);
    expect(AGENT_PRESETS.qoder.approvals).toBe('own');
    expect(AGENT_PRESETS.dsh.name).toBe('DeepSeek Harness');
    expect(AGENT_PRESETS.opencode.name).toBe('opencode');
  });

  it('passes no variable whose name a harness scrubs', () => {
    for (const id of AGENT_PRESET_IDS) {
      const s = spec();
      const names = [...Object.keys(AGENT_PRESETS[id].env(s)), ...Object.keys(s.bridge.env)];
      for (const name of names) expect(name, id).not.toMatch(/KEY|PASSWORD|SECRET|TOKEN/i);
    }
  });
});

describe('presetForClient', () => {
  it('names the preset each MCP client belongs to', () => {
    const clients: Array<[string, AgentPresetId]> = [
      ['claude-code', 'claude'], ['dsh-mcp-client', 'dsh'], ['codex-mcp-client', 'codex'], ['codex', 'codex'],
      ['gemini-cli-mcp-client', 'gemini'], ['qwen-code', 'qwen'], ['GitHub Copilot CLI', 'copilot'],
      ['cursor-vscode', 'cursor'], ['opencode', 'opencode'], ['kimi-code', 'kimi'], ['auggie', 'auggie'],
      ['goose', 'goose'], ['droid', 'droid'], ['factory-cli', 'droid'], ['qodercli', 'qoder'], ['kiro-cli', 'kiro'],
    ];
    for (const [client, preset] of clients) expect(presetForClient(client), client).toBe(preset);
  });

  it('knows no preset for an app it has not heard of', () => {
    expect(presetForClient('my-notes-app')).toBeNull();
    expect(presetForClient('')).toBeNull();
  });
});

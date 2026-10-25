import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentStartError, type AgentResult, type AgentRun } from '../../../src/main/teammate/agents/runner';
import { EventEmitter } from 'node:events';
import type { RunInfo } from '../../../src/main/teammate/actions';
import { AskController, type AskDeps } from '../../../src/main/teammate/askController';
import { strings } from '../../../src/shared/i18n';
import { DEFAULT_SETTINGS, type Settings } from '../../../src/shared/settings';
import type { AgentRunSpec } from '../../../src/shared/teammate/agents';
import type { Spot } from '../../../src/shared/teammate/askMachine';
import { zoomRect } from '../../../src/shared/teammate/coords';
import type { ThreadRecord } from '../../../src/shared/teammate/history';
import {
  DEFAULT_TEAMMATE, type AgentProfile, type BuiltinProfile, type TeammateSettings,
} from '../../../src/shared/teammate/settings';
import type { BubbleState, CardState } from '../../../src/shared/teammateIpc';

const DISPLAY = { x: 0, y: 0, w: 3200, h: 2000 };
const t = strings('en').teammate;
const VSCODE = { app: 'Code.exe', title: 'app.ts - lolPing - Visual Studio Code', window: '42', pid: 4242 };

const agent = (over: Partial<AgentProfile> = {}): AgentProfile => ({
  id: 'cc', kind: 'agent', name: 'My Claude', tagColor: 1, tagColorCustom: null, preset: 'claude', command: 'claude',
  customArgs: [], folder: { kind: 'fixed', path: 'C:\\code\\lolPing' }, timeoutS: 300, ...over,
});

const builtin: BuiltinProfile = {
  id: 'fast', kind: 'builtin', name: 'fast', tagColor: 3, tagColorCustom: null, provider: 'openai', protocol: 'openai',
  baseUrl: 'https://api.example.com/v1', model: 'fast-model',
};

const spot = (intent: Spot['intent'], x = 1000, y = 800): Spot => ({ intent, phys: { x, y }, displayId: 1 });

interface Started {
  profile: AgentProfile;
  spec: AgentRunSpec;
  cwd: string;
  env: NodeJS.ProcessEnv;
  kills: number;
  /** The session id the agent has printed so far. */
  session: string | null;
  exit(r: Partial<AgentResult>): void;
}

interface Options {
  teammate?: Partial<TeammateSettings>;
  foreground?: { app: string; title: string; window: string; pid: number };
  startThrows?: AgentStartError;
  /** The bridge server isn't listening: no command for an agent. */
  bridgeDown?: boolean;
  /** No agents deps at all. */
  noAgents?: boolean;
  /** What the user does with a permission prompt: the default is Allow once; 'wait' leaves it until the ask ends. */
  consent?: 'allow' | 'deny' | 'wait';
  lang?: 'en' | 'zh-CN';
}

function harness(opts: Options = {}) {
  const pings: Array<{ id: string; x: number; y: number }> = [];
  const bubbles: BubbleState[] = [];
  const cards: CardState[] = [];
  const started: Started[] = [];
  const asks: string[] = [];
  const written = new Map<string, string>();
  const appends: Array<{ threadId: string | null; line: string; markdown: string; agent: ThreadRecord['agent'] }> = [];
  let captures = 0;
  const prompts: Array<{ run: RunInfo; req: { tool: string; input: unknown }; signal: AbortSignal }> = [];
  const actions = Object.assign(new EventEmitter(), {
    take: () => undefined,
    put: async () => undefined,
    cancel: () => undefined,
    described: () => [] as string[],
    askAgent: (run: RunInfo, req: { tool: string; input: unknown }, signal: AbortSignal) => {
      prompts.push({ run, req, signal });
      if (opts.consent === 'wait') {
        return new Promise<'allow' | 'deny'>((resolve) => {
          signal.addEventListener('abort', () => resolve('deny'), { once: true });
        });
      }
      return Promise.resolve(opts.consent ?? 'allow');
    },
  });

  const settings: Settings = {
    ...DEFAULT_SETTINGS,
    teammate: { ...DEFAULT_TEAMMATE, profiles: [agent()], defaultProfile: 'cc', ...opts.teammate },
  };

  const agents: AskDeps['agents'] = {
    runner: {
      start: async (profile, spec, cwd, env) => {
        if (opts.startThrows) throw opts.startThrows;
        let resolve: (r: AgentResult) => void = () => undefined;
        const done = new Promise<AgentResult>((r) => { resolve = r; });
        const s: Started = {
          profile, spec, cwd, env, kills: 0, session: null,
          exit: (r) => resolve({ code: 0, session: null, error: null, tail: '', ...r }),
        };
        started.push(s);
        const run: AgentRun = {
          done,
          session: () => s.session,
          kill: () => {
            s.kills += 1;
            resolve({ code: null, session: null, error: null, tail: '' });
          },
        };
        return run;
      },
    },
    bridge: {
      command: (ask) => {
        asks.push(ask);
        return opts.bridgeDown ? null : { command: 'lolPing.exe', args: ['bridge.js'], env: { LOLPING_ASK: ask } };
      },
    },
    env: async () => ({ PATH: 'C:\\bin' }),
    home: () => 'C:\\Users\\a',
    platform: 'win',
  };

  const deps: AskDeps = {
    settings: () => settings,
    enabled: () => true,
    lang: () => opts.lang ?? 'en',
    secrets: { available: () => true, key: () => null, instructions: () => '' },
    context: {
      foreground: async () => opts.foreground ?? VSCODE,
      capture: async (req) => {
        captures += 1;
        return {
          overviewPath: `${req.dir}/overview-c${captures}.jpg`,
          overview: { w: 1600, h: 1000 },
          zooms: req.spots.map((p, i) => ({
            path: `${req.dir}/zoom-c${captures}-${i + 1}.jpg`, rect: req.crops?.[i] ?? zoomRect(req.display, p),
          })),
        };
      },
      read: async (req) => ({
        status: { marks: 'off', text: 'off', file: 'off', boxes: 'off', fields: 'off' },
        fields: null, marks: null, text: null, file: null, boxes: req.boxes ? req.spots.map(() => []) : null,
      }),
    },
    ownPid: 1000,
    readers: {
      readFile: async () => '',
      readDocument: async () => {
        throw new Error('no file');
      },
      fetchWebPdf: async () => {
        throw new Error('no network in tests');
      },
      readPdfBuffer: async () => {
        throw new Error('no PDFs in tests');
      },
    },
    adapter: () => {
      throw new Error('an agent ask never makes a provider adapter');
    },
    overlay: {
      spawnMate: (p) => void pings.push(p),
      spawnMateEmote: () => undefined,
      mateSaid: () => undefined,
      clearMate: () => undefined,
      fadeMate: () => undefined,
      setMateTicket: () => undefined,
      setCaptureExcluded: () => undefined,
      displayAt: () => ({ id: 1, rect: DISPLAY }),
      toLocal: (p) => ({ displayId: 1, x: p.x / 2, y: p.y / 2 }),
      toDip: (p) => ({ x: p.x / 2, y: p.y / 2 }),
      primaryDip: () => ({ x: 960, y: 540 }),
    },
    windows: {
      showBubble: (_at, s) => void bubbles.push(s),
      updateBubble: (s) => void bubbles.push(s),
      hideBubble: () => undefined,
      hideNow: () => undefined,
      showCard: (_at, s) => void cards.push(s),
      updateCard: (s) => void cards.push(s),
      hideCard: () => undefined,
      placeOf: () => null,
      setCaptureExcluded: () => undefined,
    },
    history: {
      current: () => null,
      append: async (threadId, entry, meta) => {
        appends.push({ threadId, line: entry.line, markdown: entry.markdown, agent: meta.agent });
        return { id: `t${appends.length}`, ...meta, started: 0, lastActivity: 0, entries: [entry] };
      },
      amend: async () => undefined,
    },
    tempDir: () => 'tmp',
    thumbnail: () => 'thumb',
    now: () => Date.now(),
    usage: () => undefined,
    files: {
      read: async (p) => Buffer.from(p),
      write: async (p, text) => void written.set(p, text),
      makeDir: async () => undefined,
      removeDir: async () => undefined,
    },
    actions,
    ...(opts.noAgents ? {} : { agents }),
  };
  const ctl = new AskController(deps);
  return {
    ctl, pings, bubbles, cards, started, asks, written, appends, prompts, captures: () => captures,
    lines: () => bubbles.map((b) => b.line),
    /** The ask token the latest agent was given. */
    token: () => started.at(-1)?.spec.bridge.env.LOLPING_ASK ?? '',
  };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 200; i += 1) await Promise.resolve();
}

const textOf = (r: { content: unknown[] }): string => {
  const first = r.content[0] as { text?: string } | undefined;
  return first?.text ?? '';
};

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('AskController with an agent', () => {
  it('starts the agent with the ask written into its folder and one fixed prompt line', async () => {
    const h = harness();
    h.ctl.ask([spot('danger')]);
    await flush();
    expect(h.started).toHaveLength(1);
    const { spec, profile, env } = h.started[0];
    expect(profile.id).toBe('cc');
    expect(env).toEqual({ PATH: 'C:\\bin' });
    expect(h.asks).toEqual([spec.bridge.env.LOLPING_ASK]);
    expect(h.token()).toMatch(/^ask-[a-z0-9-]+\.[0-9a-f]{32}$/);
    expect(spec.prompt).toContain(spec.askDir);
    expect(spec.resume).toBeNull();

    const md = h.written.get(join(spec.askDir, 'ask.md')) ?? '';
    expect(md).toContain("You are the user's teammate inside lolPing");
    expect(md).toContain('overview-c1.jpg');
    expect(md).toContain('zoom-c1-1.jpg');
    expect(md).toContain('Window title: app.ts - lolPing - Visual Studio Code');
    const json = JSON.parse(h.written.get(join(spec.askDir, 'ask.json')) ?? '{}') as Record<string, unknown>;
    expect(json).toEqual({
      intent: 'danger', words: null, app: 'Code.exe', title: VSCODE.title, spots: [{ x: 500, y: 400 }], file: null,
      selection: '',
    });
  });

  it('marks the ask received at its agent\'s first tools/list, not at a probe connection', async () => {
    const h = harness();
    h.ctl.ask([spot('danger')]);
    await flush();
    // dsh's probe connects and leaves without listing: nothing reaches the controller, so no receipt.
    await vi.advanceTimersByTimeAsync(9_000);
    expect(h.pings).toEqual([]);
    expect(h.ctl.agentTools('ask-x.0123456789abcdef0123456789abcdef')).toBeNull();
    expect(h.pings).toEqual([]);

    const tools = h.ctl.agentTools(h.token());
    expect(tools?.map((d) => d.name)).toEqual(expect.arrayContaining(['say', 'ping', 'emote', 'answer']));
    expect(tools?.map((d) => d.name)).toContain('consent');
    expect(h.pings.map((p) => p.id)).toEqual(['omw']);
    h.ctl.agentTools(h.token());
    expect(h.pings.map((p) => p.id)).toEqual(['omw']); // once

    // Received, so the 10 s from the start passes without a failure.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.ctl.running).toBe(true);
  });

  it('fails when the agent lists no tools within 10 s of starting, and stops it', async () => {
    const h = harness();
    h.ctl.ask([spot('danger')]);
    await flush();
    await vi.advanceTimersByTimeAsync(9_999);
    expect(h.ctl.running).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.lines()).toEqual(['Claude Code didn’t connect to lolPing within 10 seconds.']);
    expect(h.started[0].kills).toBe(1);
  });

  it('says where to add lolPing when an agent that reads its own MCP settings does not connect', async () => {
    const lines = async (preset: AgentProfile['preset'], lang: 'en' | 'zh-CN' = 'en'): Promise<string | undefined> => {
      const h = harness({ teammate: { profiles: [agent({ preset, name: 'Mine' })], defaultProfile: 'cc' }, lang });
      h.ctl.ask([spot('danger')]);
      await flush();
      await vi.advanceTimersByTimeAsync(10_000);
      return h.lines().at(-1);
    };
    expect(await lines('cursor')).toBe(
      'Cursor CLI didn’t connect to lolPing within 10 seconds. Check that lolPing is in ~/.cursor/mcp.json.',
    );
    expect(await lines('qoder')).toBe(
      'Qoder CLI didn’t connect to lolPing within 10 seconds. Check that lolPing is in its MCP settings.',
    );
    expect(await lines('custom')).toBe('Mine didn’t connect to lolPing within 10 seconds.');
    expect(await lines('cursor', 'zh-CN'))
      .toBe('Cursor CLI 在 10 秒内没有连接到 lolPing。请检查 ~/.cursor/mcp.json 里是否加了 lolPing。');
    expect(await lines('qoder', 'zh-CN')).toBe('Qoder CLI 在 10 秒内没有连接到 lolPing。请检查它的 MCP 设置里是否加了 lolPing。');
  });

  it('draws an agent\'s say, ping and answer like a model\'s', async () => {
    const h = harness();
    h.ctl.ask([spot('danger')]);
    await flush();
    h.ctl.agentTools(h.token());
    const said = await h.ctl.agentCall(h.token(), 'say', { text: 'Line 3 divides by zero.' });
    expect(said).toEqual({ content: [{ text: 'Done.' }], isError: false });
    expect(h.lines()).toEqual(['Line 3 divides by zero.']);
    await h.ctl.agentCall(h.token(), 'ping', { type: 'danger', x: 600, y: 400 });
    expect(h.pings.at(-1)).toEqual(expect.objectContaining({ id: 'danger', x: 600, y: 400 }));
    await h.ctl.agentCall(h.token(), 'answer', { markdown: 'B3 is 0.' });
    const bad = await h.ctl.agentCall(h.token(), 'ping', { type: 'nope' });
    expect(bad.isError).toBe(true);
    expect(h.ctl.running).toBe(true); // the agent's exit ends the ask

    h.started[0].exit({ code: 0, session: 'sess-1' });
    await flush();
    expect(h.ctl.running).toBe(false);
    expect(h.appends).toEqual([{
      threadId: null, line: 'Line 3 divides by zero.', markdown: 'B3 is 0.',
      agent: { profileId: 'cc', session: 'sess-1', cwd: 'C:\\code\\lolPing' },
    }]);
    h.ctl.onTeammateAction('bubble', { t: 'more' });
    expect(h.cards.at(-1)?.footer).toEqual(expect.objectContaining({ profile: 'My Claude', model: '' }));
  });

  it('answers a look with the zoom as base64, once per ask', async () => {
    const h = harness();
    h.ctl.ask([spot('assist')]);
    await flush();
    expect(h.ctl.agentTools(h.token())?.map((d) => d.name)).toContain('look');
    const look = await h.ctl.agentCall(h.token(), 'look', { x: 100, y: 100, w: 200, h: 100 });
    expect(look.isError).toBe(false);
    const image = look.content.find((c) => 'image' in c);
    const data = Buffer.from(`${h.started[0].spec.askDir}/zoom-c2-1.jpg`).toString('base64');
    expect(image).toEqual({ image: { mime: 'image/jpeg', data } });
    expect(h.ctl.agentTools(h.token())?.map((d) => d.name)).not.toContain('look');
    const again = await h.ctl.agentCall(h.token(), 'look', { x: 100, y: 100, w: 200, h: 100 });
    expect(again).toEqual({ content: [{ text: 'Not available.' }], isError: true });
  });

  it('offers the consent tool only to a preset that routes its permission prompts to lolPing', async () => {
    const claude = harness();
    claude.ctl.ask([spot('danger')]);
    await flush();
    expect(claude.ctl.agentTools(claude.token())?.map((d) => d.name)).toContain('consent');

    for (const profile of [agent({ preset: 'dsh' }), agent({ preset: 'custom' })]) {
      const h = harness({ teammate: { profiles: [profile] } });
      h.ctl.ask([spot('danger')]);
      await flush();
      expect(h.ctl.agentTools(h.token())?.map((d) => d.name), profile.preset).not.toContain('consent');
      const r = await h.ctl.agentCall(h.token(), 'consent', { tool_name: 'Write', input: {} });
      expect(r, profile.preset).toEqual({ content: [{ text: 'Not available.' }], isError: true });
      expect(h.prompts, profile.preset).toEqual([]);
    }
  });

  it('asks the user for a permission prompt and answers allow with the input', async () => {
    const h = harness();
    h.ctl.ask([spot('danger')]);
    await flush();
    h.ctl.agentTools(h.token());
    const input = { file_path: 'src/app.ts', old_string: 'teh', new_string: 'the' };
    const r = await h.ctl.agentCall(h.token(), 'consent', { tool_name: 'Edit', input, tool_use_id: 'toolu_1' });
    expect(r.isError).toBe(false);
    expect(r.content).toHaveLength(1);
    expect(JSON.parse(textOf(r))).toEqual({ behavior: 'allow', updatedInput: input });
    expect(h.prompts).toHaveLength(1);
    expect(h.prompts[0].req).toEqual({ tool: 'Edit', input });
    // The runner gets the folder the agent runs in, which Always allow on an edit is checked against.
    expect(h.prompts[0].run).toMatchObject({ profileId: 'cc', profileName: 'My Claude', cwd: 'C:\\code\\lolPing' });
  });

  it('answers deny when the user declines', async () => {
    const h = harness({ consent: 'deny' });
    h.ctl.ask([spot('danger')]);
    await flush();
    h.ctl.agentTools(h.token());
    const r = await h.ctl.agentCall(h.token(), 'consent', { tool_name: 'Bash', input: { command: 'rm -rf x' } });
    expect(r.isError).toBe(false);
    expect(JSON.parse(textOf(r))).toEqual({ behavior: 'deny', message: 'The user declined in lolPing.' });
  });

  it('refuses a permission prompt whose tool name no permission key can hold, without asking', async () => {
    const h = harness();
    h.ctl.ask([spot('danger')]);
    await flush();
    h.ctl.agentTools(h.token());
    for (const args of [{ tool_name: 'Ed:it', input: {} }, { tool_name: 'Edit' }, 'Edit', null]) {
      const r = await h.ctl.agentCall(h.token(), 'consent', args);
      expect(r.isError).toBe(false);
      expect(JSON.parse(textOf(r)), JSON.stringify(args)).toMatchObject({ behavior: 'deny' });
    }
    expect(h.prompts).toEqual([]);
  });

  it('answers deny to a permission prompt still waiting when the ask ends', async () => {
    const h = harness({ consent: 'wait' });
    h.ctl.ask([spot('danger')]);
    await flush();
    h.ctl.agentTools(h.token());
    const pending = h.ctl.agentCall(h.token(), 'consent', { tool_name: 'Write', input: { file_path: 'a.md' } });
    await flush();
    expect(h.prompts[0].signal.aborted).toBe(false);
    h.ctl.cancel('user');
    const r = await pending;
    expect(r.isError).toBe(false);
    expect(JSON.parse(textOf(r))).toEqual({ behavior: 'deny', message: 'The user declined in lolPing.' });
    expect(h.prompts[0].signal.aborted).toBe(true);
  });

  it('refuses calls from an ask that was replaced', async () => {
    const h = harness();
    h.ctl.ask([spot('danger')]);
    await flush();
    const first = h.token();
    h.ctl.agentTools(first);
    h.ctl.ask([spot('danger', 2000, 1200)]);
    await flush();
    expect(h.started).toHaveLength(2);
    expect(h.started[0].kills).toBe(1);

    const r = await h.ctl.agentCall(first, 'say', { text: 'Stale.' });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toBe('That ask is over.');
    expect(h.ctl.agentTools(first)).toBeNull();
    expect(h.lines()).not.toContain('Stale.');
  });

  it('stops the agent when the ask is cancelled', async () => {
    const h = harness();
    h.ctl.ask([spot('danger')]);
    await flush();
    h.ctl.cancel('user');
    await flush();
    expect(h.started[0].kills).toBe(1);
    expect(h.ctl.running).toBe(false);
  });

  it('fails with the agent\'s error line when it exits before answering', async () => {
    const h = harness();
    h.ctl.ask([spot('danger')]);
    await flush();
    h.ctl.agentTools(h.token());
    h.started[0].exit({ code: 1, error: 'Not logged in · Please run /login' });
    await flush();
    expect(h.lines()).toEqual(['Claude Code: Not logged in · Please run /login']);
    expect(h.pings.map((p) => p.id)).toEqual(['omw', 'missing']);
    expect(h.appends).toEqual([]);

    h.ctl.ask([spot('danger')]);
    await flush();
    h.started[1].exit({ code: 1, error: 'e'.repeat(300) });
    await flush();
    expect(h.lines().at(-1)).toBe(`Claude Code: ${'e'.repeat(200)}`);

    h.ctl.ask([spot('danger')]);
    await flush();
    h.started[2].exit({ code: 0 });
    await flush();
    expect(h.lines().at(-1)).toBe('Claude Code stopped without answering.');
  });

  it('fails at once when the command is not found', async () => {
    const h = harness({ startThrows: new AgentStartError('notFound', "Couldn't find claude") });
    h.ctl.ask([spot('danger')]);
    await flush();
    expect(h.lines()).toEqual(['Couldn’t start claude: not found']);
    expect(h.pings.map((p) => p.id)).toEqual(['missing']);
    expect(h.ctl.running).toBe(false);
  });

  it('says it couldn\'t start the agent when spawning fails', async () => {
    const h = harness({ startThrows: new AgentStartError('spawn', 'EACCES') });
    h.ctl.ask([spot('danger')]);
    await flush();
    expect(h.lines()).toEqual(['Couldn’t start claude']);
  });

  it('says the working folder is gone when it is', async () => {
    const h = harness({ startThrows: new AgentStartError('noFolder', 'no folder') });
    h.ctl.ask([spot('danger')]);
    await flush();
    expect(h.lines()).toEqual(['The folder lolPing isn’t there any more.']);
    const zh = harness({ startThrows: new AgentStartError('noFolder', 'no folder'), lang: 'zh-CN' });
    zh.ctl.ask([spot('danger')]);
    await flush();
    expect(zh.lines()).toEqual(['文件夹 lolPing 已经不在了。']);
  });

  it('asks for a restart when lolPing\'s agent connection isn\'t open', async () => {
    for (const opts of [{ bridgeDown: true }, { noAgents: true }]) {
      const h = harness(opts);
      h.ctl.ask([spot('danger')]);
      await flush();
      expect(h.started).toEqual([]);
      expect(h.lines()).toEqual(['lolPing couldn’t open its agent connection. Restart lolPing.']);
      expect(h.ctl.running).toBe(false);
    }
  });

  it('times out after the profile\'s timeout, not 60 s', async () => {
    const h = harness({ teammate: { profiles: [agent({ timeoutS: 120 })], defaultProfile: 'cc' } });
    h.ctl.ask([spot('danger')]);
    await flush();
    h.ctl.agentTools(h.token());
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.ctl.running).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.ctl.running).toBe(false);
    expect(h.lines()).toEqual([t.ask.failed.timeout]);
    expect(h.started[0].kills).toBe(1);
  });

  it('keeps an agent\'s answer when it outlives its timeout', async () => {
    const h = harness({ teammate: { profiles: [agent({ timeoutS: 120 })], defaultProfile: 'cc' } });
    h.ctl.ask([spot('danger')]);
    await flush();
    h.ctl.agentTools(h.token());
    await h.ctl.agentCall(h.token(), 'say', { text: 'Line 3 divides by zero.' });
    await h.ctl.agentCall(h.token(), 'ping', { type: 'danger', x: 600, y: 400 });
    await h.ctl.agentCall(h.token(), 'answer', { markdown: 'B3 is 0.' });
    // It goes on working (editing files, say) past its time.
    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.ctl.running).toBe(false);
    expect(h.started[0].kills).toBe(1);
    expect(h.lines()).not.toContain(t.ask.failed.timeout);
    expect(h.lines().at(-1)).toBe('Line 3 divides by zero.');
    expect(h.pings.map((p) => p.id)).toEqual(['omw', 'danger']);
    expect(h.appends).toEqual([expect.objectContaining({ line: 'Line 3 divides by zero.', markdown: 'B3 is 0.' })]);
  });

  it('keeps the session of an agent that outlives its timeout, so the thread resumes it', async () => {
    const h = harness({ teammate: { profiles: [agent({ timeoutS: 120 })], defaultProfile: 'cc' } });
    h.ctl.ask([spot('danger')]);
    await flush();
    h.ctl.agentTools(h.token());
    h.started[0].session = 'sess-late';
    await h.ctl.agentCall(h.token(), 'say', { text: 'Line 3 divides by zero.' });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.started[0].kills).toBe(1);
    const kept = { profileId: 'cc', session: 'sess-late', cwd: 'C:\\code\\lolPing' };
    expect(h.appends).toEqual([expect.objectContaining({ agent: kept })]);
    expect(h.ctl.currentThread()?.agent).toEqual(kept);
  });

  it('resumes the thread\'s agent session in the folder it was recorded in', async () => {
    const thread = (profileId: string): ThreadRecord => ({
      id: 'th1', title: 'Earlier', started: 0, lastActivity: 0, app: 'Code.exe', windowTitle: '', profile: 'My Claude',
      entries: [{ at: 0, intent: 'danger', words: null, line: 'Earlier line.', markdown: '', thumb: '', spots: 1 }],
      agent: { profileId, session: 'sess-9', cwd: 'D:\\old' },
    });
    const h = harness();
    h.ctl.continueThread(thread('cc'));
    h.ctl.ask([spot('push')]);
    await flush();
    expect(h.started[0].spec.resume).toBe('sess-9');
    expect(h.started[0].cwd).toBe('D:\\old');
    h.ctl.agentTools(h.token());
    await h.ctl.agentCall(h.token(), 'say', { text: 'More.' });
    h.started[0].exit({ code: 0, session: 'sess-9' });
    await flush();
    expect(h.appends.at(-1)).toEqual(expect.objectContaining({
      threadId: 'th1', agent: { profileId: 'cc', session: 'sess-9', cwd: 'D:\\old' },
    }));

    // Another profile's session isn't this agent's to resume.
    const other = harness();
    other.ctl.continueThread(thread('someone-else'));
    other.ctl.ask([spot('push')]);
    await flush();
    expect(other.started[0].spec.resume).toBeNull();
    expect(other.started[0].cwd).toBe('C:\\code\\lolPing');
  });

  it('runs in the folder the editor title names', async () => {
    const folders = (list: string[]) => ({
      teammate: { profiles: [agent({ folder: { kind: 'editor', folders: list } })], defaultProfile: 'cc' },
    });
    const footer = async (h: ReturnType<typeof harness>) => {
      h.ctl.agentTools(h.token());
      await h.ctl.agentCall(h.token(), 'say', { text: 'Done it.' });
      h.ctl.onTeammateAction('bubble', { t: 'more' });
      return h.cards.at(-1)?.footer.used.at(-1);
    };

    const named = harness(folders(['C:\\code\\other', 'C:\\code\\lolPing']));
    named.ctl.ask([spot('danger')]);
    await flush();
    expect(named.started[0].cwd).toBe('C:\\code\\lolPing');
    expect(await footer(named)).toBe('Folder: lolPing');

    const first = harness({
      ...folders(['C:\\code\\other', 'C:\\code\\lolPing']), foreground: { ...VSCODE, title: 'x' },
    });
    first.ctl.ask([spot('danger')]);
    await flush();
    expect(first.started[0].cwd).toBe('C:\\code\\other');
    expect(await footer(first)).toBe('Folder: other (first in the list)');

    const home = harness(folders([]));
    home.ctl.ask([spot('danger')]);
    await flush();
    expect(home.started[0].cwd).toBe('C:\\Users\\a');
    expect(await footer(home)).toBe('Folder: home');
  });

  it('says Do it went to the first agent in the footer', async () => {
    const h = harness({ teammate: { profiles: [builtin, agent()], defaultProfile: 'fast' } });
    h.ctl.ask([spot('omw')]);
    await flush();
    expect(h.started).toHaveLength(1);
    h.ctl.agentTools(h.token());
    await h.ctl.agentCall(h.token(), 'say', { text: 'Fixed it.' });
    h.ctl.onTeammateAction('bubble', { t: 'more' });
    expect(h.cards.at(-1)?.footer.route).toBe(t.ask.route.doIt);
  });

  it('reads ahead for an agent profile and spawns the agent only at the key-up', async () => {
    const h = harness({ teammate: { profiles: [agent({ timeoutS: 120 })], defaultProfile: 'cc' } });
    h.ctl.prepare([spot('danger')]);
    await flush();
    expect(h.captures()).toBe(1);
    expect(h.asks).toEqual([]);
    expect(h.started).toEqual([]);
    await vi.advanceTimersByTimeAsync(100_000);

    h.ctl.ask([spot('danger')]);
    await flush();
    expect(h.captures()).toBe(1);
    expect(h.started).toHaveLength(1);
    const { spec } = h.started[0];
    expect(h.written.get(join(spec.askDir, 'ask.md'))).toContain('overview-c1.jpg');
    // The profile's time limit runs from the key-up.
    h.ctl.agentTools(h.token());
    await vi.advanceTimersByTimeAsync(119_999);
    expect(h.ctl.running).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.lines()).toEqual([t.ask.failed.timeout]);
  });
});

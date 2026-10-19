import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AskController, type AskDeps } from '../../../src/main/teammate/askController';
import { ContextError } from '../../../src/main/teammate/contextClient';
import type { RawCall, StreamHandlers, Turn, TurnResult } from '../../../src/main/teammate/providers/types';
import { strings } from '../../../src/shared/i18n';
import { DEFAULT_SETTINGS, type Settings } from '../../../src/shared/settings';
import type { Spot } from '../../../src/shared/teammate/askMachine';
import { zoomRect } from '../../../src/shared/teammate/coords';
import type { ThreadRecord } from '../../../src/shared/teammate/history';
import { bubbleMs } from '../../../src/shared/teammate/line';
import { DEFAULT_TEAMMATE, type BuiltinProfile, type TeammateSettings } from '../../../src/shared/teammate/settings';
import type { ToolDef } from '../../../src/shared/teammate/tools';
import type { BubbleState, CardState } from '../../../src/shared/teammateIpc';

/** One physical display at 200 %: overlay CSS px and DIPs are half the physical px; the overview is half too. */
const DISPLAY = { x: 0, y: 0, w: 3200, h: 2000 };
const TAG = { name: 'AI', color: 3, rgb: null };
const PRIMARY = { x: 960, y: 540 };
const t = strings('en').teammate;

const profile = (id: string): BuiltinProfile => ({
  id, kind: 'builtin', name: id, tagColor: 3, tagColorCustom: null, provider: 'openai', protocol: 'openai',
  baseUrl: 'https://api.example.com/v1', model: `${id}-model`, vision: 'auto',
});

const spot = (intent: Spot['intent'], x = 1000, y = 800): Spot => ({ intent, phys: { x, y }, displayId: 1 });

interface Req { system: string; turns: Turn[]; tools: ToolDef[]; model: string }
type Step = (req: Req, h: StreamHandlers, signal: AbortSignal) => Promise<TurnResult>;

const call = (name: string, args: unknown, id = name): RawCall => ({ id, name, args: JSON.stringify(args) });

/** A provider turn that accepts at once and answers with these calls. */
const answers = (calls: RawCall[], text = ''): Step => async (_req, h) => {
  h.accepted();
  h.usage({ input: 100, output: 20 });
  return { text, calls };
};

/** A provider turn that never finishes until the ask is aborted. */
const hangs = (opts: { accept: boolean }): Step => (_req, h, signal) => {
  if (opts.accept) h.accepted();
  return new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  });
};

type Entry = [string, unknown];
type DrawnPing = { id: string; x: number; y: number; silent?: boolean };

interface HarnessOptions {
  teammate?: Partial<TeammateSettings>;
  key?: string | null;
  steps?: Step[];
  /** History is off: append returns a fresh unsaved record each time and nothing becomes current (HistoryStore). */
  historyOff?: boolean;
  /** now() runs this far ahead of the timers from the capture until the request goes out (libuv's cached time). */
  skewAfterCapture?: number;
  captureThrows?: boolean;
  noDisplay?: boolean;
  /** Sees the key each adapter is made with. */
  onAdapter?: (key: string) => void;
}

function harness(opts: HarnessOptions = {}) {
  const log: Entry[] = [];
  const steps = [...(opts.steps ?? [])];
  const requests: Req[] = [];
  const signals: AbortSignal[] = [];
  const adapters: string[] = [];
  const tickets: string[] = [];
  const appends: Array<{ threadId: string | null; line: string; markdown: string }> = [];
  const states: boolean[] = [];
  let current: ThreadRecord | null = null;
  let captures = 0;
  let skew = 0;
  const popupsAt: Array<{ x: number; y: number }> = [];

  const settings: Settings = {
    ...DEFAULT_SETTINGS,
    teammate: { ...DEFAULT_TEAMMATE, profiles: [profile('fast')], defaultProfile: 'fast', ...opts.teammate },
  };

  const deps: AskDeps = {
    settings: () => settings,
    lang: () => 'en',
    secrets: {
      available: () => true,
      key: () => (opts.key === undefined ? 'sk-test' : opts.key),
      instructions: () => '',
    },
    context: {
      foreground: async () => ({ app: 'notepad.exe', title: 'notes.txt' }),
      capture: async (req) => {
        captures += 1;
        log.push(['capture', req.spots]);
        if (opts.captureThrows) throw new ContextError('capture', 'no screen');
        skew = opts.skewAfterCapture ?? 0;
        return {
          overviewPath: `ov${captures}.jpg`,
          overview: { w: 1600, h: 1000 },
          zooms: req.spots.map((p, i) => ({ path: `zoom${captures}-${i}.jpg`, rect: zoomRect(req.display, p) })),
        };
      },
    },
    adapter: (p, key) => {
      adapters.push(p.id);
      opts.onAdapter?.(key);
      return {
        turn: (req, h, signal) => {
          requests.push(req);
          skew = 0; // sentAt was read ahead of the timers' clock
          signals.push(signal);
          const step = steps.shift();
          return step ? step(req, h, signal) : Promise.resolve({ text: '', calls: [] });
        },
        listModels: async () => [],
      };
    },
    overlay: {
      spawnMate: (p) => log.push(['ping', p]),
      spawnMateEmote: (p) => log.push(['emote', p]),
      mateSaid: () => log.push(['said', null]),
      clearMate: () => log.push(['clear', null]),
      fadeMate: () => log.push(['fade', null]),
      setMateTicket: (id) => tickets.push(id),
      setCaptureExcluded: (on) => log.push(['overlaysExcluded', on]),
      displayAt: () => (opts.noDisplay ? null : { id: 1, rect: DISPLAY }),
      toLocal: (p) => (opts.noDisplay ? null : { displayId: 1, x: p.x / 2, y: p.y / 2 }),
      toDip: (p) => (opts.noDisplay ? null : { x: p.x / 2, y: p.y / 2 }),
      primaryDip: () => PRIMARY,
    },
    windows: {
      showBubble: (at, s) => {
        popupsAt.push(at);
        log.push(['bubble', s]);
      },
      updateBubble: (s) => log.push(['bubble', s]),
      hideBubble: () => log.push(['bubbleHidden', null]),
      showCard: (_at, s) => log.push(['card', s]),
      updateCard: (s) => log.push(['card', s]),
      hideCard: () => log.push(['cardHidden', null]),
      setCaptureExcluded: (on) => log.push(['windowsExcluded', on]),
    },
    history: {
      current: () => current,
      append: async (threadId, entry, meta) => {
        appends.push({ threadId, line: entry.line, markdown: entry.markdown });
        if (opts.historyOff) {
          return { id: `unsaved${appends.length}`, ...meta, started: 0, lastActivity: 0, entries: [entry] };
        }
        current = threadId !== null && current?.id === threadId
          ? { ...current, entries: [...current.entries, entry] }
          : { id: `t${appends.length}`, ...meta, started: 0, lastActivity: 0, entries: [entry] };
        return current;
      },
    },
    tempDir: () => 'tmp',
    thumbnail: () => 'thumb',
    now: () => Date.now() + skew,
    usage: () => undefined,
    cursor: () => ({ x: 1200, y: 900 }),
    files: { read: async (p) => Buffer.from(p), remove: async () => undefined },
  };
  const ctl = new AskController(deps);
  ctl.on('state', (running: boolean) => states.push(running));

  const of = (kind: string): unknown[] => log.filter((e) => e[0] === kind).map((e) => e[1]);
  return {
    ctl, log, requests, signals, adapters, tickets, appends, states, of, popupsAt,
    pings: (id?: string) => (of('ping') as DrawnPing[]).filter((p) => id === undefined || p.id === id),
    bubbles: () => of('bubble') as BubbleState[],
    cards: () => of('card') as CardState[],
  };
}

/** Lets every pending promise in the ask settle, without moving the clock. */
async function flush(): Promise<void> {
  for (let i = 0; i < 200; i += 1) await Promise.resolve();
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('AskController', () => {
  it('places the receipt when the provider accepts, then the line and pings', async () => {
    const h = harness({
      steps: [answers([
        call('ping', { type: 'danger', x: 600, y: 400 }),
        call('say', { text: 'Line 3 divides by zero.' }),
      ])],
    });
    // The user's own ping is drawn by the overlay at release; the controller adds only the teammate's marks.
    h.ctl.ask(spot('danger'));
    await flush();

    const drawn = h.log.filter((e) => e[0] === 'ping' || e[0] === 'bubble');
    expect(drawn).toHaveLength(3);
    expect(drawn[0]).toEqual(['ping', expect.objectContaining({
      id: 'omw', displayId: 1, x: 520, y: 380, thinking: true, keep: true, tag: TAG,
    })]);
    expect((drawn[0][1] as { silent?: boolean }).silent).toBeFalsy();
    expect(drawn[1]).toEqual(['bubble', expect.objectContaining({
      line: 'Line 3 divides by zero.', thinking: false, thread: null,
    })]);
    expect(drawn[2]).toEqual(['ping', { displayId: 1, x: 600, y: 400, id: 'danger', ring: true, tag: TAG }]);

    // Overlays and teammate windows are out of the capture only while it runs.
    const kinds = h.log.map((e) => `${e[0]}:${String(e[1] === null || typeof e[1] === 'boolean' ? e[1] : '')}`);
    const captureAt = kinds.indexOf('capture:');
    expect(kinds.indexOf('overlaysExcluded:true')).toBeLessThan(captureAt);
    expect(kinds.indexOf('windowsExcluded:true')).toBeLessThan(captureAt);
    expect(kinds.indexOf('overlaysExcluded:false')).toBeGreaterThan(captureAt);
    expect(kinds.indexOf('windowsExcluded:false')).toBeGreaterThan(captureAt);

    expect(h.ctl.running).toBe(false);
    expect(h.states).toEqual([true, false]);
    expect(h.appends).toEqual([{ threadId: null, line: 'Line 3 divides by zero.', markdown: '' }]);

    // The receipt stays until the answer has had its time on screen, then fades with the bubble.
    expect(h.of('fade')).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(bubbleMs('Line 3 divides by zero.'));
    expect(h.of('fade')).toHaveLength(1);
    expect(h.of('bubbleHidden')).toHaveLength(1);
  });

  it('shows plain text as the line when the model calls no tools', async () => {
    const h = harness({ steps: [answers([], 'The sum in B4 counts row 3 twice.')] });
    h.ctl.ask(spot('danger'));
    await flush();
    expect(h.bubbles().map((b) => b.line)).toEqual(['The sum in B4 counts row 3 twice.']);
    expect(h.pings('missing')).toEqual([]);
  });

  it('ignores tool calls that arrive after the ask was cancelled', async () => {
    let finish: (r: TurnResult) => void = () => undefined;
    const first: Step = (_req, h) => {
      h.accepted();
      return new Promise((resolve) => {
        finish = resolve;
      });
    };
    const h = harness({ steps: [first, hangs({ accept: false })] });
    h.ctl.ask(spot('danger'));
    await flush();
    expect(h.pings('omw')).toHaveLength(1);

    h.ctl.ask(spot('missing', 2000, 1200));
    await flush();
    expect(h.signals[0].aborted).toBe(true);
    expect(h.tickets).toHaveLength(2);
    expect(h.tickets[0]).not.toBe(h.tickets[1]);

    const late = [call('ping', { type: 'danger', x: 10, y: 10 }), call('say', { text: 'Too late.' })];
    finish({ text: 'late', calls: late });
    await flush();
    await vi.advanceTimersByTimeAsync(5000);
    expect(h.pings('danger')).toEqual([]);
    expect(h.bubbles()).toEqual([]);
    expect(h.of('clear')).toHaveLength(1);
    expect(h.ctl.running).toBe(true);
  });

  it('says set me up first without a profile or key', async () => {
    for (const setup of [{ teammate: { profiles: [], defaultProfile: null } }, { key: null }]) {
      const h = harness(setup);
      h.ctl.ask(spot('danger'));
      await flush();
      expect(h.adapters).toEqual([]);
      expect(h.of('capture')).toEqual([]);
      expect(h.pings()).toEqual([expect.objectContaining({ id: 'missing', x: 520, y: 380, tag: TAG })]);
      expect(h.bubbles().map((b) => b.line)).toEqual([t.ask.failed.noProfile]);
      expect(h.ctl.running).toBe(false);
    }
  });

  it('fails with a line when nothing is received in 10 s', async () => {
    const h = harness({ steps: [hangs({ accept: false })] });
    h.ctl.ask(spot('danger'));
    await flush();
    await vi.advanceTimersByTimeAsync(9_999);
    expect(h.pings()).toEqual([]);
    expect(h.ctl.running).toBe(true);

    await vi.advanceTimersByTimeAsync(1);
    expect(h.signals[0].aborted).toBe(true);
    expect(h.pings()).toEqual([expect.objectContaining({ id: 'missing' })]);
    expect(h.bubbles().map((b) => b.line)).toEqual([t.ask.failed.notReceived]);
    expect(h.ctl.running).toBe(false);
    expect(h.appends).toEqual([]);
  });

  it('answers look with a new capture and continues', async () => {
    let second: Turn[] = [];
    const h = harness({
      steps: [
        answers([call('look', { x: 500, y: 300, w: 200, h: 150 }, 'l1')]),
        async (req) => {
          second = [...req.turns]; // the controller keeps adding to the same list
          return { text: '', calls: [call('say', { text: 'It says 42.' })] };
        },
      ],
    });
    h.ctl.ask(spot('needvision'));
    await flush();

    // The look area's centre in the overview (600, 375) is (1200, 750) on the display.
    expect(h.of('capture')).toEqual([[{ x: 1000, y: 800 }], [{ x: 1200, y: 750 }]]);
    expect(h.of('overlaysExcluded')).toEqual([true, false, true, false]);
    const last = second[second.length - 1];
    expect(last.role).toBe('tool');
    if (last.role !== 'tool') return;
    expect(last.results[0].id).toBe('l1');
    expect(last.results[0].content).toContainEqual({ image: { mime: 'image/jpeg', data: Buffer.from('zoom2-0.jpg') } });
    expect(h.bubbles().map((b) => b.line)).toEqual(['It says 42.']);
  });

  it('continues the thread with push and labels the bubble', async () => {
    const h = harness({
      steps: [answers([call('say', { text: 'First answer.' })]), answers([call('say', { text: 'More detail.' })])],
    });
    h.ctl.ask(spot('missing'));
    await flush();
    h.ctl.ask(spot('push', 1010, 805));
    await flush();

    expect(h.bubbles().map((b) => [b.line, b.thread])).toEqual([
      ['First answer.', null],
      ['More detail.', 'First answer.'],
    ]);
    expect(h.appends.map((a) => a.threadId)).toEqual([null, 't1']);
    const firstTurn = h.requests[1].turns[0];
    const earlier = { text: 'Earlier in this thread, newest first:' };
    expect(firstTurn.role === 'user' && firstTurn.parts).toContainEqual(earlier);
    // Push on the same spot opens the card by itself, with the whole thread in it.
    const card = h.cards().at(-1);
    const answered = card?.entries.filter((e) => e.kind === 'answer').map((e) => e.markdown);
    expect(answered).toEqual(['First answer.', 'More detail.']);
    expect(card?.streaming).toBe(false);
  });

  it('opens the card by itself for Whole picture', async () => {
    const h = harness({
      teammate: { profiles: [profile('fast'), profile('deep')], defaultProfile: 'fast', deepProfile: 'deep' },
      steps: [answers([
        call('say', { text: 'A plan with two risks.' }),
        call('answer', { markdown: '## Risks\n- cost' }),
      ])],
    });
    h.ctl.ask(spot('allin'));
    await flush();
    expect(h.adapters).toEqual(['deep']);
    const card = h.cards().at(-1);
    expect(card?.entries.at(-1)).toEqual({
      kind: 'answer', label: 'AI', markdown: 'A plan with two risks.\n\n## Risks\n- cost',
    });
    expect(card?.footer).toEqual({ profile: 'deep', model: 'deep-model', tokens: 120, used: [t.ask.usedScreen] });
    expect(h.requests[0].model).toBe('deep-model');
  });

  it('clears everything on pause', async () => {
    const h = harness({ steps: [hangs({ accept: true })] });
    h.ctl.ask(spot('danger'));
    await flush();
    expect(h.pings('omw')).toHaveLength(1);

    h.ctl.cancel('pause');
    await flush();
    expect(h.signals[0].aborted).toBe(true);
    expect(h.of('clear')).toHaveLength(1);
    expect(h.of('bubbleHidden')).toHaveLength(1);
    expect(h.of('cardHidden')).toHaveLength(1);
    expect(h.ctl.running).toBe(false);
    expect(h.states).toEqual([true, false]);
    await vi.advanceTimersByTimeAsync(70_000);
    expect(h.pings('missing')).toEqual([]);
  });

  it('places pings 600 ms apart with one sound, and drops those still waiting when paused', async () => {
    const ping = (x: number, order: number) => call('ping', { type: 'assist', x, y: 100, order }, `p${x}`);
    const h = harness({
      steps: [answers([ping(300, 3), ping(100, 1), ping(200, 2), call('say', { text: 'Three steps.' })])],
    });
    h.ctl.ask(spot('assist'));
    await flush();
    // Lowest order first; overview x 100 is physical 200, overlay 100.
    expect(h.pings('assist').map((p) => p.x)).toEqual([100]);
    await vi.advanceTimersByTimeAsync(599);
    expect(h.pings('assist')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.pings('assist')).toEqual([
      expect.objectContaining({ x: 100 }),
      expect.objectContaining({ x: 200, silent: true }),
    ]);
    expect(h.pings('assist')[0].silent).toBeUndefined();

    h.ctl.cancel('pause');
    await vi.advanceTimersByTimeAsync(5000);
    expect(h.pings('assist')).toHaveLength(2);
  });

  it('points at the user\'s spot for mark 1 and drops unknown marks', async () => {
    const h = harness({
      steps: [answers([
        call('ping', { type: 'generic', mark: 1 }, 'a'),
        call('ping', { type: 'generic', mark: 2 }, 'b'),
        call('ping', { type: 'generic', x: 5000, y: 5 }, 'c'),
        call('say', { text: 'Here.' }),
      ])],
    });
    h.ctl.ask(spot('generic'));
    await flush();
    await vi.advanceTimersByTimeAsync(2000);
    expect(h.pings('generic')).toEqual([{ displayId: 1, x: 500, y: 400, id: 'generic', tag: TAG }]);
  });

  it('shows only the dots on a tag for a Do it ask, and is silent when the receipt sound is off', async () => {
    const h = harness({ teammate: { receiptSound: false }, steps: [hangs({ accept: true })] });
    h.ctl.ask(spot('omw'));
    await flush();
    expect(h.pings('omw')).toEqual([
      expect.objectContaining({ tagOnly: true, thinking: true, keep: true, silent: true }),
    ]);
  });

  it('opens the card from More with the rest of a long line, and a reply continues the thread', async () => {
    const long = 'The cell adds row 3 twice. The total should be 41, which also changes the average in B9 below it.';
    const h = harness({
      steps: [answers([call('say', { text: long })]), answers([call('say', { text: 'B9 is 8.2.' })])],
    });
    h.ctl.ask(spot('danger'));
    await flush();
    expect(h.bubbles()).toEqual([expect.objectContaining({ line: 'The cell adds row 3 twice.', more: true })]);

    h.ctl.onTeammateAction('bubble', { t: 'more' });
    expect(h.of('bubbleHidden')).toHaveLength(1);
    expect(h.cards().at(-1)?.entries.at(-1)?.markdown).toBe(long);

    h.ctl.onTeammateAction('card', { t: 'reply', text: 'And B9?' });
    await flush();
    expect(h.appends.map((a) => a.threadId)).toEqual([null, 't1']);
    const card = h.cards().at(-1);
    expect(card?.entries.map((e) => e.markdown)).toEqual(['', long, 'And B9?', 'B9 is 8.2.']);
    expect(card?.streaming).toBe(false);
  });

  it('fails a provider that never answers even when the clock runs a few ms behind the timers', async () => {
    for (const accept of [false, true]) {
      const h = harness({ skewAfterCapture: 5, steps: [hangs({ accept })] });
      h.ctl.ask(spot('danger'));
      await flush();
      await vi.advanceTimersByTimeAsync(accept ? 60_000 : 10_000);
      expect(h.signals[0].aborted).toBe(true);
      expect(h.bubbles().map((b) => b.line)).toEqual([accept ? t.ask.failed.timeout : t.ask.failed.notReceived]);
      expect(h.ctl.running).toBe(false);
    }
  });

  it('continues the thread with push while history is off, and labels the bubble', async () => {
    const h = harness({
      historyOff: true,
      steps: [
        answers([call('say', { text: 'First answer.' })]),
        answers([call('say', { text: 'More detail.' })]),
        answers([call('say', { text: 'Even more.' })]),
      ],
    });
    h.ctl.ask(spot('missing'));
    await flush();
    h.ctl.ask(spot('push', 1010, 805));
    await flush();
    h.ctl.cancel('pause'); // a pause clears the screen but not the thread
    h.ctl.ask(spot('push', 1500, 900));
    await flush();
    expect(h.bubbles().map((b) => b.thread)).toEqual([null, 'First answer.', 'First answer.']);
    const turn = h.requests[2].turns[0];
    const earlier = turn.role === 'user' ? turn.parts.flatMap((p) => ('text' in p ? [p.text] : [])) : [];
    expect(earlier.filter((s) => s.startsWith('Earlier ask'))).toHaveLength(2);
    expect(h.ctl.currentThread()?.entries.map((e) => e.line)).toEqual(['First answer.', 'More detail.', 'Even more.']);
  });

  it('continues a thread picked in History', async () => {
    const h = harness({ steps: [answers([call('say', { text: 'Back to it.' })])] });
    const picked: ThreadRecord = {
      id: 'old', title: 'Old thread', started: 0, lastActivity: 0, app: '', windowTitle: '', profile: 'fast',
      entries: [{ at: 0, intent: 'missing', words: null, line: 'Long ago.', markdown: '', thumb: '' }],
    };
    h.ctl.continueThread(picked);
    h.ctl.ask(spot('push'));
    await flush();
    expect(h.bubbles().map((b) => b.thread)).toEqual(['Old thread']);
    expect(h.appends.map((a) => a.threadId)).toEqual(['old']);
  });

  it('opens a thread from History as a card, and a reply in it continues that thread at the cursor', async () => {
    const h = harness({ steps: [answers([call('say', { text: 'Still there.' })])] });
    const picked: ThreadRecord = {
      id: 'old', title: 'Old thread', started: 0, lastActivity: 0, app: '', windowTitle: '', profile: 'fast',
      entries: [{ at: 0, intent: 'missing', words: null, line: 'Long ago.', markdown: '', thumb: '' }],
    };
    h.ctl.showThread(picked, { x: 100, y: 100 });
    expect(h.cards()).toEqual([expect.objectContaining({
      title: 'Old thread', streaming: false,
      entries: [
        { kind: 'ask', label: t.intent.missing.label, markdown: '' },
        { kind: 'answer', label: 'AI', markdown: 'Long ago.' },
      ],
    })]);
    expect(h.states).toEqual([]); // nothing is asked by opening it
    const hidden = h.of('cardHidden').length;
    h.ctl.onTeammateAction('card', { t: 'reply', text: 'and now?' });
    await flush();
    expect(h.of('capture')[0]).toEqual([{ x: 1200, y: 900 }]);
    expect(h.appends.map((a) => a.threadId)).toEqual(['old']);
    expect(h.of('cardHidden')).toHaveLength(hidden); // the card stays and fills in
    expect(h.cards().at(-1)?.entries.map((e) => e.markdown)).toEqual(['', 'Long ago.', 'and now?', 'Still there.']);
  });

  it('asks a local server with no key', async () => {
    const local: BuiltinProfile = { ...profile('fast'), provider: 'ollama', baseUrl: 'http://localhost:11434/v1' };
    const keys: string[] = [];
    const h = harness({
      key: null, teammate: { profiles: [local] }, steps: [answers([call('say', { text: 'Local answer.' })])],
      onAdapter: (key) => keys.push(key),
    });
    h.ctl.ask(spot('danger'));
    await flush();
    expect(keys).toEqual(['']);
    expect(h.bubbles().map((b) => b.line)).toEqual(['Local answer.']);
  });

  it('starts a new thread after History forgets the one it held', async () => {
    // History off: the controller alone holds the thread, as it does in the app once History has been cleared.
    const h = harness({
      historyOff: true,
      steps: [answers([call('say', { text: 'First.' })]), answers([call('say', { text: 'Second.' })])],
    });
    h.ctl.ask(spot('danger'));
    await flush();
    const held = h.ctl.currentThread()?.id;
    expect(held).toBeDefined();
    h.ctl.forgetThread('another-id');
    expect(h.ctl.currentThread()?.id).toBe(held);
    h.ctl.forgetThread(); // History was cleared
    h.ctl.ask(spot('push'));
    await flush();
    expect(h.appends.map((a) => a.threadId)).toEqual([null, null]);
  });

  it('stops after 6 rounds and never captures for a look on the last one', async () => {
    const look = (n: number) => answers([call('look', { x: 500, y: 300, w: 200, h: 150 }, `l${n}`)]);
    const h = harness({ steps: [1, 2, 3, 4, 5, 6, 7].map(look) });
    h.ctl.ask(spot('needvision'));
    await flush();
    expect(h.requests).toHaveLength(6);
    expect(h.of('capture')).toHaveLength(6); // the ask's own capture and the looks of rounds 1 to 5
    expect(h.ctl.running).toBe(false);
  });

  it('lets the overlays and windows back into captures when a capture throws', async () => {
    const h = harness({ captureThrows: true });
    h.ctl.ask(spot('danger'));
    await flush();
    expect(h.of('overlaysExcluded')).toEqual([true, false]);
    expect(h.of('windowsExcluded')).toEqual([true, false]);
    expect(h.bubbles().map((b) => b.line)).toEqual([t.ask.failed.capture]);
  });

  it('shows the line on the primary display when no display is under the spot', async () => {
    const h = harness({ noDisplay: true });
    h.ctl.ask(spot('danger'));
    await flush();
    expect(h.bubbles().map((b) => b.line)).toEqual([t.ask.failed.capture]);
    expect(h.popupsAt).toEqual([PRIMARY]);
  });

  it('reports a provider that refuses images as a failure line', async () => {
    const { ProviderError } = await import('../../../src/main/teammate/providers/types');
    const h = harness({
      steps: [async () => {
        throw new ProviderError('images', 'image input is not supported', 400);
      }],
    });
    h.ctl.ask(spot('danger'));
    await flush();
    expect(h.bubbles().map((b) => b.line)).toEqual([t.ask.failed.images]);
    expect(h.pings()).toEqual([expect.objectContaining({ id: 'missing' })]);
  });

  it('tells the model a tool is not available and ignores over-limit emotes', async () => {
    let second: Turn[] = [];
    const h = harness({
      steps: [
        answers([
          call('paste', { text: 'x' }, 'p'),
          call('emote', { slug: 'facepalm', x: 10, y: 10 }, 'e1'),
          call('emote', { slug: 'facepalm', x: 20, y: 10 }, 'e2'),
          call('say', { text: 'Done.' }, 's'),
        ]),
        async (req) => {
          second = [...req.turns]; // the controller keeps adding to the same list
          return { text: '', calls: [] };
        },
      ],
    });
    h.ctl.ask(spot('danger'));
    await flush();
    expect(h.of('emote')).toHaveLength(1);
    const last = second[second.length - 1];
    expect(last.role === 'tool' && last.results.map((r) => r.id)).toEqual(['p', 'e1', 'e2', 's']);
    expect(last.role === 'tool' && last.results[0].content).toEqual([{ text: 'Not available.' }]);
  });
});

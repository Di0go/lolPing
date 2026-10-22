import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AskController, type AskDeps } from '../../../src/main/teammate/askController';
import { ContextError } from '../../../src/main/teammate/contextClient';
import type { Doc } from '../../../src/main/teammate/files';
import type { RawCall, StreamHandlers, Turn, TurnResult } from '../../../src/main/teammate/providers/types';
import { strings } from '../../../src/shared/i18n';
import { DEFAULT_SETTINGS, type Settings } from '../../../src/shared/settings';
import type { Spot } from '../../../src/shared/teammate/askMachine';
import type { SystemTextLayer } from '../../../src/shared/teammate/contextProtocol';
import { zoomRect, type Rect } from '../../../src/shared/teammate/coords';
import type { ThreadRecord } from '../../../src/shared/teammate/history';
import { bubbleMs } from '../../../src/shared/teammate/line';
import { DEFAULT_TEAMMATE, type BuiltinProfile, type TeammateSettings } from '../../../src/shared/teammate/settings';
import type { ActionCall, ToolDef } from '../../../src/shared/teammate/tools';
import type { BubbleState, CardState } from '../../../src/shared/teammateIpc';

/** One physical display at 200 %: overlay CSS px and DIPs are half the physical px; the overview is half too. */
const DISPLAY = { x: 0, y: 0, w: 3200, h: 2000 };
const TAG = { name: 'AI', color: 3, rgb: null };
const PRIMARY = { x: 960, y: 540 };
const t = strings('en').teammate;

const profile = (id: string): BuiltinProfile => ({
  id, kind: 'builtin', name: id, tagColor: 3, tagColorCustom: null, provider: 'openai', protocol: 'openai',
  baseUrl: 'https://api.example.com/v1', model: `${id}-model`,
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
  /** The capture writes its overview into the run's folder, then waits until the ask is aborted. */
  captureHangs?: boolean;
  noDisplay?: boolean;
  /** Sees the key each adapter is made with. */
  onAdapter?: (key: string) => void;
  /** What the context helper and the file readers find; tests may change it between asks. */
  screen?: Partial<Screen>;
  /** Wires an action runner that records the calls it is given. */
  recordActions?: boolean;
}

interface Screen {
  /** `slow`: the helper ran over its budget on it; `hangs`: no answer until the ask is aborted. */
  system: SystemTextLayer | 'slow' | 'hangs';
  /** The helper's marks file. */
  marksFile: string;
  /** The helper's form fields file: one JSON field per line. */
  fields: string;
  /** The file behind the window; null: none. */
  doc: Doc | null;
  /** The boxes around the element under the spot, innermost first, ending with its window. */
  boxes: Rect[];
}

const NO_TEXT: SystemTextLayer = { selection: '', spotTexts: [], focus: null, address: '' };

function harness(opts: HarnessOptions = {}) {
  const log: Entry[] = [];
  const steps = [...(opts.steps ?? [])];
  const requests: Req[] = [];
  const signals: AbortSignal[] = [];
  const adapters: string[] = [];
  const tickets: string[] = [];
  const appends: Array<{ threadId: string | null; line: string; markdown: string }> = [];
  const taken: ActionCall[] = [];
  const states: boolean[] = [];
  let current: ThreadRecord | null = null;
  let captures = 0;
  let skew = 0;
  const popupsAt: Array<{ x: number; y: number }> = [];
  /** The fake disk: folders and files under the temp folder. */
  const disk = new Set<string>();
  const dirs: string[] = [];
  const screen: Screen = { system: NO_TEXT, marksFile: '', fields: '', doc: null, boxes: [], ...opts.screen };

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
      foreground: async () => ({ app: 'notepad.exe', title: 'notes.txt', window: '263544' }),
      capture: async (req, signal) => {
        captures += 1;
        log.push(['capture', req.spots]);
        log.push(['framed', { area: req.area ?? null, crops: req.crops ?? null }]);
        dirs.push(req.dir);
        if (opts.captureThrows) throw new ContextError('capture', 'no screen');
        if (opts.captureHangs) {
          disk.add(`${req.dir}/overview.jpg`);
          return new Promise((_resolve, reject) => {
            signal?.addEventListener('abort', () => reject(new ContextError('capture', 'aborted')), { once: true });
          });
        }
        skew = opts.skewAfterCapture ?? 0;
        return {
          overviewPath: `ov${captures}.jpg`,
          overview: { w: 1600, h: 1000 },
          zooms: req.spots.map((p, i) => ({
            path: `zoom${captures}-${i}.jpg`, rect: req.crops?.[i] ?? zoomRect(req.display, p),
          })),
        };
      },
      read: async (req, signal) => {
        const { system } = screen;
        if (req.text && system === 'hangs') {
          return new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(new ContextError('aborted', 'cancelled')), { once: true });
          });
        }
        const text = !req.text ? 'off' : system === 'slow' ? 'slow' : 'ok';
        return {
          status: {
            marks: req.marks ? 'ok' : 'off', text, file: req.file ? 'ok' : 'off', boxes: req.boxes ? 'ok' : 'off',
            fields: req.fields ? 'ok' : 'off',
          },
          fields: req.fields ? { path: `${req.dir}/fields.jsonl`, count: 1 } : null,
          marks: req.marks ? { path: `${req.dir}/marks.tsv`, count: 1 } : null,
          text: typeof system === 'object' && req.text ? system : null,
          file: !req.file ? null : screen.doc
            ? { path: `C:/docs/${screen.doc.name}`, address: '', how: 'title' }
            : { path: '', address: '', how: 'none' },
          boxes: req.boxes ? req.spots.map(() => screen.boxes) : null,
        };
      },
    },
    readers: {
      readFile: async (path) => (path.endsWith('fields.jsonl') ? screen.fields : screen.marksFile),
      readDocument: async () => {
        if (!screen.doc) throw new Error('no file');
        return screen.doc;
      },
      fetchWebPdf: async () => {
        throw new Error('no network in tests');
      },
      readPdfBuffer: async () => {
        throw new Error('no PDFs in tests');
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
    ...(opts.recordActions ? { actions: { take: (c: ActionCall) => void taken.push(c) } } : {}),
    files: {
      read: async (p) => Buffer.from(p),
      makeDir: async (d) => void disk.add(d),
      removeDir: async (d) => {
        for (const f of [...disk]) if (f === d || f.startsWith(`${d}/`)) disk.delete(f);
      },
    },
  };
  const ctl = new AskController(deps);
  ctl.on('state', (running: boolean) => states.push(running));

  const of = (kind: string): unknown[] => log.filter((e) => e[0] === kind).map((e) => e[1]);
  return {
    ctl, log, requests, signals, adapters, tickets, appends, states, of, popupsAt, disk, dirs, screen, taken,
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
    expect(drawn[2]).toEqual(['ping', { displayId: 1, x: 600, y: 400, id: 'danger', keep: true, tag: TAG }]);

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

    // The bubble goes first; the receipt and pings stay 15 s after the answer, then fade.
    await vi.advanceTimersByTimeAsync(bubbleMs('Line 3 divides by zero.'));
    expect(h.of('bubbleHidden')).toHaveLength(1);
    expect(h.of('fade')).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(15_000 - bubbleMs('Line 3 divides by zero.'));
    expect(h.of('fade')).toHaveLength(1);
  });

  it('shows plain text as the line when the model calls no tools', async () => {
    const h = harness({ steps: [answers([], 'The sum in B4 counts row 3 twice.')] });
    h.ctl.ask(spot('danger'));
    await flush();
    expect(h.bubbles().map((b) => b.line)).toEqual(['The sum in B4 counts row 3 twice.']);
    expect(h.pings('missing')).toEqual([]);
  });

  it('offers More without asking again when the model gives only a line', async () => {
    const h = harness({
      steps: [answers([call('say', { text: 'Line 3 divides by zero.' }), call('ping', { type: 'danger', spot: 1 }, 'p')])],
    });
    h.ctl.ask(spot('danger'));
    await flush();
    expect(h.requests).toHaveLength(1); // another round for a card answer would double the wait
    expect(h.bubbles().at(-1)).toEqual(expect.objectContaining({ line: 'Line 3 divides by zero.', more: true }));
    expect(h.appends).toEqual([{ threadId: null, line: 'Line 3 divides by zero.', markdown: '' }]);
  });

  it('shows the line as soon as its say is complete, before the card answer behind it, and only once', async () => {
    let finish: (r: TurnResult) => void = () => undefined;
    const say = call('say', { text: 'Line 3 divides by zero.' });
    const slow: Step = (_req, h) => {
      h.accepted();
      h.call?.(say);
      return new Promise((resolve) => { finish = resolve; });
    };
    const h = harness({ steps: [slow] });
    h.ctl.ask(spot('danger'));
    await flush();
    expect(h.ctl.running).toBe(true);
    expect(h.bubbles().map((b) => b.line)).toEqual(['Line 3 divides by zero.']);

    finish({ text: '', calls: [say, call('answer', { markdown: 'B3 is 0.' })] });
    await flush();
    expect(h.bubbles().at(-1)).toEqual(expect.objectContaining({ line: 'Line 3 divides by zero.', more: true }));
    expect(h.appends).toEqual([{ threadId: null, line: 'Line 3 divides by zero.', markdown: 'B3 is 0.' }]);
  });

  it('keeps the line up while its answer is still coming, then gives it its full time', async () => {
    let finish: (r: TurnResult) => void = () => undefined;
    const say = call('say', { text: 'Short.' });
    const slow: Step = (_req, h) => {
      h.accepted();
      h.call?.(say);
      return new Promise((resolve) => { finish = resolve; });
    };
    const h = harness({ steps: [slow] });
    h.ctl.ask(spot('danger'));
    await flush();
    await vi.advanceTimersByTimeAsync(bubbleMs('Short.') + 5_000);
    expect(h.of('bubbleHidden')).toHaveLength(0);

    finish({ text: '', calls: [say, call('answer', { markdown: 'More.' })] });
    await flush();
    await vi.advanceTimersByTimeAsync(bubbleMs('Short.') - 100);
    expect(h.of('bubbleHidden')).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(200);
    expect(h.of('bubbleHidden')).toHaveLength(1);
  });

  it('takes the line from the card answer when the model gives only that', async () => {
    const markdown = '- **B4** counts row 3 twice. It should skip it.\n- C2 is empty.';
    const h = harness({ steps: [answers([call('answer', { markdown })])] });
    h.ctl.ask(spot('danger'));
    await flush();
    expect(h.requests).toHaveLength(1);
    expect(h.bubbles().at(-1)).toEqual(expect.objectContaining({
      line: 'B4 counts row 3 twice. It should skip it.', more: true,
    }));
    // The card shows the answer once: the line came from it, so it is not repeated above it.
    h.ctl.onTeammateAction('bubble', { t: 'more' });
    expect(h.cards().at(-1)?.entries.at(-1)).toEqual(expect.objectContaining({ line: '', markdown }));
    expect(h.cards().at(-1)?.title).toBe('B4 counts row 3 twice. It should skip it.');
  });

  it('asks only once when the model only wrote text', async () => {
    const h = harness({ steps: [answers([], 'The sum in B4 counts row 3 twice.')] });
    h.ctl.ask(spot('danger'));
    await flush();
    expect(h.requests).toHaveLength(1);
    expect(h.bubbles().at(-1)).toEqual(expect.objectContaining({ line: 'The sum in B4 counts row 3 twice.', more: true }));
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
    h.ctl.ask(spot('allin'));
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
    // The look's round goes on anyway, so the reminder to end with a line and a card costs nothing.
    expect(last.results.at(-1)?.content.at(-1)).toEqual({ text: expect.stringMatching(/`say`.*`answer`/) });
  });

  it('asks once more when a round ends with pings and neither a line nor a card answer', async () => {
    const h = harness({
      steps: [
        answers([call('ping', { type: 'danger', spot: 1 }, 'p')]),
        answers([call('say', { text: 'B3 is empty.' })]),
      ],
    });
    h.ctl.ask(spot('danger'));
    await flush();
    expect(h.requests).toHaveLength(2);
    const asked = h.requests[1].turns[2];
    expect(asked?.role === 'tool' && asked.results[0].content.at(-1))
      .toEqual({ text: expect.stringMatching(/`say`.*`answer`/) });
    expect(h.bubbles().at(-1)).toEqual(expect.objectContaining({ line: 'B3 is empty.' }));
  });

  it('asks only once more when the model keeps answering with pings alone', async () => {
    const pingOnly = answers([call('ping', { type: 'danger', spot: 1 }, 'p')]);
    const h = harness({ steps: [pingOnly, pingOnly, pingOnly] });
    h.ctl.ask(spot('danger'));
    await flush();
    expect(h.requests).toHaveLength(2);
  });

  it('continues the thread with push and labels the bubble', async () => {
    const h = harness({
      steps: [
        answers([call('say', { text: 'First answer.' })]), answers([call('say', { text: 'More detail.' })]),
      ],
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
    const answered = card?.entries.filter((e) => e.kind === 'answer').map((e) => e.line);
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
      kind: 'answer', label: 'AI', line: 'A plan with two risks.', markdown: '## Risks\n- cost',
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

  describe('the teammate marks that stay with the answer', () => {
    const withCard = () => harness({
      steps: [answers([
        call('say', { text: 'Line 3 divides by zero.' }),
        call('answer', { markdown: 'B3 is 0, so =A3/B3 fails.' }),
        call('ping', { type: 'danger', x: 600, y: 400 }, 'p'),
        call('emote', { slug: 'facepalm', x: 200, y: 100 }, 'e'),
      ])],
    });

    it('spawns every ping and emote to stay, like the receipt', async () => {
      const h = withCard();
      h.ctl.ask(spot('danger'));
      await flush();
      expect(h.pings('danger')).toEqual([expect.objectContaining({ keep: true })]);
      expect(h.of('emote')).toEqual([expect.objectContaining({ slug: 'facepalm', keep: true })]);
    });

    it('keeps the teammate pings while the card is open', async () => {
      const h = withCard();
      h.ctl.ask(spot('danger'));
      await flush();
      h.ctl.onTeammateAction('bubble', { t: 'more' });
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(h.of('fade')).toHaveLength(0);
      expect(h.of('clear')).toHaveLength(0);
    });

    it('fades the pings 15 s after the answer at the earliest', async () => {
      const h = harness({
        steps: [answers([call('say', { text: 'Short.' }), call('ping', { type: 'danger', x: 600, y: 400 })])],
      });
      h.ctl.ask(spot('danger'));
      await flush();
      await vi.advanceTimersByTimeAsync(bubbleMs('Short.') + 1_000); // the bubble is long gone
      expect(h.of('bubbleHidden')).toHaveLength(1);
      expect(h.of('fade')).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(15_000 - bubbleMs('Short.') - 1_000 - 1);
      expect(h.of('fade')).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(1);
      expect(h.of('fade')).toHaveLength(1);
    });

    it('fades the pings when the card closes after that', async () => {
      const h = withCard();
      h.ctl.ask(spot('danger'));
      await flush();
      h.ctl.onTeammateAction('bubble', { t: 'more' });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(h.of('fade')).toHaveLength(0);
      h.ctl.onTeammateAction('card', { t: 'close' });
      await vi.advanceTimersByTimeAsync(0);
      expect(h.of('fade')).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(h.of('fade')).toHaveLength(1);
    });

    it('waits out the 15 s when the card closes before that', async () => {
      const h = withCard();
      h.ctl.ask(spot('danger'));
      await flush();
      h.ctl.onTeammateAction('bubble', { t: 'more' });
      await vi.advanceTimersByTimeAsync(5_000);
      h.ctl.onTeammateAction('card', { t: 'close' });
      await vi.advanceTimersByTimeAsync(9_999);
      expect(h.of('fade')).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(1);
      expect(h.of('fade')).toHaveLength(1);
    });

    it('holds a fade that was already waiting when the card opens', async () => {
      const h = withCard();
      h.ctl.ask(spot('danger'));
      await flush();
      await vi.advanceTimersByTimeAsync(10_000);
      h.ctl.onTeammateAction('bubble', { t: 'more' });
      await vi.advanceTimersByTimeAsync(30_000);
      expect(h.of('fade')).toHaveLength(0);
    });

    it('clears the pings on a new ask', async () => {
      const h = harness({
        steps: [
          answers([call('say', { text: 'One.' }), call('ping', { type: 'danger', x: 600, y: 400 })]),
          hangs({ accept: true }),
        ],
      });
      h.ctl.ask(spot('danger'));
      await flush();
      h.ctl.ask(spot('danger', 1200, 900));
      await flush();
      expect(h.of('clear')).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(h.of('fade')).toHaveLength(0);
    });

    it('clears the pings on a pause even with the card open', async () => {
      const h = withCard();
      h.ctl.ask(spot('danger'));
      await flush();
      h.ctl.onTeammateAction('bubble', { t: 'more' });
      h.ctl.cancel('pause');
      expect(h.of('clear')).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(h.of('fade')).toHaveLength(0);
    });

    it('keeps the missing ping of a failed ask for the same time', async () => {
      const h = harness({ steps: [hangs({ accept: false })] });
      h.ctl.ask(spot('danger'));
      await flush();
      await vi.advanceTimersByTimeAsync(10_000); // not received
      expect(h.pings('missing')).toEqual([expect.objectContaining({ keep: true })]);
      await vi.advanceTimersByTimeAsync(14_999);
      expect(h.of('fade')).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(1);
      expect(h.of('fade')).toHaveLength(1);
    });
  });

  it('points at the user\'s spot for spot 1 and drops unknown spots', async () => {
    const h = harness({
      steps: [answers([
        call('ping', { type: 'generic', spot: 1 }, 'a'),
        call('ping', { type: 'generic', spot: 2 }, 'b'),
        call('ping', { type: 'generic', x: 5000, y: 5 }, 'c'),
        call('say', { text: 'Here.' }),
      ])],
    });
    h.ctl.ask(spot('generic'));
    await flush();
    await vi.advanceTimersByTimeAsync(2000);
    expect(h.pings('generic')).toEqual([{ displayId: 1, x: 500, y: 400, id: 'generic', keep: true, tag: TAG }]);
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
    expect(h.cards().at(-1)?.entries.at(-1)?.line).toBe(long);

    h.ctl.onTeammateAction('card', { t: 'reply', text: 'And B9?' });
    await flush();
    expect(h.appends.map((a) => a.threadId)).toEqual([null, 't1']);
    const card = h.cards().at(-1);
    // An ask shows the user's words, an answer its line.
    expect(card?.entries.map((e) => e.line ?? e.markdown)).toEqual(['', long, 'And B9?', 'B9 is 8.2.']);
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
        { kind: 'answer', label: 'AI', line: 'Long ago.', markdown: '' },
      ],
    })]);
    expect(h.states).toEqual([]); // nothing is asked by opening it
    const hidden = h.of('cardHidden').length;
    h.ctl.onTeammateAction('card', { t: 'reply', text: 'and now?' });
    await flush();
    expect(h.of('capture')[0]).toEqual([{ x: 1200, y: 900 }]);
    expect(h.appends.map((a) => a.threadId)).toEqual(['old']);
    expect(h.of('cardHidden')).toHaveLength(hidden); // the card stays and fills in
    expect(h.cards().at(-1)?.entries.map((e) => e.line ?? e.markdown))
      .toEqual(['', 'Long ago.', 'and now?', 'Still there.']);
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

  it('looks once per ask and stops after 6 rounds', async () => {
    const look = (n: number) => answers([call('look', { x: 500, y: 300, w: 200, h: 150 }, `l${n}`)]);
    const h = harness({ steps: [1, 2, 3, 4, 5, 6, 7].map(look) });
    h.ctl.ask(spot('allin'));
    await flush();
    expect(h.requests).toHaveLength(6);
    expect(h.of('capture')).toHaveLength(2); // the ask's own capture and the first look
    expect(h.requests[0].tools.map((d) => d.name)).toContain('look');
    expect(h.requests[1].tools.map((d) => d.name)).not.toContain('look');
    expect(h.ctl.running).toBe(false);
  });

  it('offers look only to Show me how and Whole picture', async () => {
    const h = harness({ steps: [answers([call('say', { text: 'A.' })]), answers([call('say', { text: 'B.' })])] });
    h.ctl.ask(spot('missing'));
    await flush();
    h.ctl.ask(spot('assist', 1300, 900));
    await flush();
    expect(h.requests[0].tools.map((d) => d.name)).not.toContain('look');
    expect(h.requests[1].tools.map((d) => d.name)).toContain('look');
  });

  it('frames the capture with the window and the block around the spot', async () => {
    const h = harness({
      screen: {
        boxes: [
          { x: 980, y: 790, w: 40, h: 20 }, { x: 600, y: 600, w: 900, h: 400 }, { x: 100, y: 100, w: 1700, h: 1100 },
        ],
      },
      steps: [answers([call('say', { text: 'A table.' })])],
    });
    h.ctl.ask(spot('missing'));
    await flush();
    expect(h.of('framed')).toEqual([{
      area: { x: 100, y: 100, w: 1700, h: 1100 }, crops: [{ x: 584, y: 584, w: 932, h: 432 }],
    }]);
    // The overview's pixels now map onto the window, not the display.
    const first = h.requests[0].turns[0];
    const text = first.role === 'user' ? first.parts.flatMap((p) => ('text' in p ? [p.text] : [])).join('\n') : '';
    expect(text).toContain('spot 1 is at x=847, y=636 in the overview.');
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

  it('fails with the images line when the provider refuses images', async () => {
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

  describe('action tools', () => {
    const toolNames = (h: ReturnType<typeof harness>): string[] => h.requests[0].tools.map((d) => d.name);
    const results = (turns: Turn[]): Array<{ id: string; content: unknown }> => {
      const last = turns[turns.length - 1];
      return last.role === 'tool' ? last.results : [];
    };

    it('offers each ask the action tools of its kind', async () => {
      const said = answers([call('say', { text: 'Ok.' })]);
      const h = harness({ steps: [said, said, said] });
      h.ctl.ask(spot('missing'));
      await flush();
      h.ctl.ask(spot('enemyvision', 1300, 900));
      await flush();
      h.ctl.ask(spot('omw', 1500, 900));
      await flush();
      const names = h.requests.map((r) => r.tools.map((d) => d.name));
      expect(names[0]).toEqual(expect.arrayContaining(['open']));
      expect(names[0]).not.toEqual(expect.arrayContaining(['copy']));
      expect(names[1]).toEqual(expect.arrayContaining(['copy', 'event', 'open']));
      expect(names[1]).not.toContain('paste');
      expect(names[2]).toEqual(expect.arrayContaining(['copy', 'paste', 'open']));
      expect(names[2]).not.toContain('fill');
      expect(names[2]).not.toContain('event');
    });

    it('lists the form fields for Do it and offers fill only then', async () => {
      const said = answers([call('say', { text: 'Ok.' })]);
      const fields = [
        { id: '42.7.1', kind: 'text', label: 'Customer name', group: '', value: '', secure: false, required: true },
        { id: '42.7.2', kind: 'text', label: 'Password', group: '', value: 'hunter2', secure: true, required: false },
      ].map((f) => JSON.stringify({ ...f, options: [] })).join('\n');
      const h = harness({ steps: [said, said], screen: { fields } });
      h.ctl.ask(spot('omw'));
      await flush();
      h.ctl.ask(spot('missing', 1500, 900));
      await flush();
      expect(h.requests[0].tools.map((d) => d.name)).toContain('fill');
      const first = h.requests[0].turns[0];
      const text = first.role === 'user' ? first.parts.map((p) => ('text' in p ? p.text : '')).join('\n') : '';
      expect(text).toContain('42.7.1 | text | Customer name |');
      expect(text).toContain('42.7.2 | text | Password | secure, never fill |');
      expect(text).not.toContain('hunter2');
      expect(h.requests[1].tools.map((d) => d.name)).not.toContain('fill');
    });

    it('hands each valid action call to the runner once and tells the model Done', async () => {
      let second: Turn[] = [];
      const h = harness({
        recordActions: true,
        steps: [
          answers([
            call('paste', { text: 'Friday works.', mode: 'insert' }, 'p'),
            call('copy', { text: 'Friday works.' }, 'c'),
            call('open', { url: 'https://example.com' }, 'o'),
            call('say', { text: 'Wrote a reply.' }, 's'),
            // Not offered to Do it without form fields: its result brings a second round, which shows the others.
            call('fill', { fields: [{ id: 'a', value: 'x' }] }, 'f'),
          ]),
          async (req) => {
            second = [...req.turns];
            return { text: '', calls: [] };
          },
        ],
      });
      h.ctl.ask(spot('omw'));
      await flush();
      expect(h.taken).toEqual([
        { tool: 'paste', text: 'Friday works.', mode: 'insert' },
        { tool: 'copy', text: 'Friday works.' },
        { tool: 'open', url: 'https://example.com' },
      ]);
      const done = [{ text: 'Done.' }];
      expect(results(second).map((r) => r.content)).toEqual([done, done, done, done, [{ text: 'Not available.' }]]);
    });

    it('refuses a call to a tool the ask was not given, and passes nothing to the runner', async () => {
      let second: Turn[] = [];
      const h = harness({
        recordActions: true,
        steps: [
          answers([
            call('paste', { text: 'x', mode: 'insert' }, 'p'),
            call('fill', { fields: [{ id: 'a', value: 'x' }] }, 'f'),
            call('event', { title: 'A', start: '2026-11-05' }, 'e'),
            call('say', { text: 'Ok.' }, 's'),
          ]),
          async (req) => {
            second = [...req.turns];
            return { text: '', calls: [] };
          },
        ],
      });
      h.ctl.ask(spot('missing'));
      await flush();
      expect(h.taken).toEqual([]);
      expect(results(second).map((r) => r.content)).toEqual([
        ...Array(3).fill([{ text: 'Not available.' }]),
        [{ text: 'Done.' }],
      ]);
    });

    it('refuses a second paste in one answer and runs only the first', async () => {
      let second: Turn[] = [];
      const h = harness({
        recordActions: true,
        steps: [
          answers([
            call('paste', { text: 'one', mode: 'insert' }, 'p1'),
            call('paste', { text: 'two', mode: 'insert' }, 'p2'),
            call('fill', { fields: [{ id: 'a', value: 'x' }] }, 'f'),
          ]),
          async (req) => {
            second = [...req.turns];
            return { text: '', calls: [] };
          },
        ],
      });
      h.ctl.ask(spot('omw'));
      await flush();
      expect(h.taken).toEqual([{ tool: 'paste', text: 'one', mode: 'insert' }]);
      expect(results(second).map((r) => r.id)).toEqual(['p1', 'p2', 'f']);
      expect(JSON.stringify(results(second)[1].content)).toContain('Ignored');
    });

    it('keeps action calls without a runner and still answers', async () => {
      const h = harness({
        steps: [answers([call('copy', { text: 'x' }, 'c'), call('say', { text: 'Grabbed it.' }, 's')])],
      });
      h.ctl.ask(spot('enemyvision'));
      await flush();
      expect(h.bubbles().some((b) => JSON.stringify(b).includes('Grabbed it.'))).toBe(true);
      expect(toolNames(h)).toContain('copy');
    });
  });

  it('removes the run folder even when the ask is cancelled while the capture runs', async () => {
    const h = harness({ captureHangs: true });
    h.ctl.ask(spot('danger'));
    await flush();
    expect(h.dirs).toHaveLength(1);
    expect(h.dirs[0].startsWith('tmp')).toBe(true);
    expect(h.dirs[0]).not.toBe('tmp'); // a folder of this ask's own
    expect([...h.disk]).toContain(`${h.dirs[0]}/overview.jpg`);
    h.ctl.cancel('pause');
    await flush();
    expect([...h.disk]).toEqual([]);
  });

  it('removes the run folder after an answer', async () => {
    const h = harness({ steps: [answers([call('say', { text: 'Fine.' })])] });
    h.ctl.ask(spot('danger'));
    await flush();
    expect(h.dirs).toHaveLength(1);
    expect([...h.disk]).toEqual([]);
  });

  it('captures and sends images for every model, whatever its name', async () => {
    const h = harness({
      teammate: { profiles: [{ ...profile('fast'), model: 'deepseek-chat' }] },
      steps: [answers([call('say', { text: 'Fine.' })])],
    });
    h.ctl.ask(spot('allin'));
    await flush();
    expect(h.of('capture')).toHaveLength(1);
    const req = h.requests[0];
    expect(req.tools.map((d) => d.name)).toContain('look');
    const first = req.turns[0];
    expect(first.role === 'user' && first.parts.some((part) => 'image' in part)).toBe(true);
  });

  it('snaps a ping onto the button it aims at', async () => {
    const h = harness({
      // A Save button at physical (900, 700), 200 x 60: its centre is (1000, 730).
      screen: { marksFile: 'button\t900\t700\t200\t60\tSave\n' },
      steps: [answers([
        call('ping', { type: 'assist', x: 460, y: 355 }, 'p'), // physical (920, 710): inside it, off centre
        call('say', { text: 'Click Save.' }),
        call('answer', { markdown: 'Save writes the file.' }),
      ])],
    });
    h.ctl.ask(spot('assist'));
    await flush();
    expect(h.pings('assist')).toEqual([{ displayId: 1, x: 500, y: 365, id: 'assist', keep: true, tag: TAG }]);
    const first = h.requests[0].turns[0];
    const text = first.role === 'user' ? first.parts.flatMap((p) => ('text' in p ? [p.text] : [])).join('\n') : '';
    expect(text).toContain('button "Save" box 450,350,100,30');
    expect(h.requests[0].system).toContain('Use the boxes in the marks list to aim.');
  });

  it('snaps the pings of other asks too, without listing the marks in their prompt', async () => {
    const h = harness({
      screen: { marksFile: 'button\t900\t700\t200\t60\tSave\n' },
      steps: [answers([
        call('ping', { type: 'danger', x: 460, y: 355 }, 'p'),
        call('say', { text: 'Save is greyed out.' }),
        call('answer', { markdown: 'Nothing changed yet.' }),
      ])],
    });
    h.ctl.ask(spot('danger'));
    await flush();
    expect(h.pings('danger')).toEqual([{ displayId: 1, x: 500, y: 365, id: 'danger', keep: true, tag: TAG }]);
    const first = h.requests[0].turns[0];
    const text = first.role === 'user' ? first.parts.flatMap((p) => ('text' in p ? [p.text] : [])).join('\n') : '';
    expect(text).not.toContain('Save');
    expect(h.requests[0].system).not.toContain('marks list');
  });

  it('reads the file behind the window only for Whole picture', async () => {
    const doc = { name: 'book.pdf', kind: 'pdf' as const, outline: [], sections: [{ label: 'p. 1', text: 'Chapter one' }] };
    const h = harness({
      screen: { doc },
      steps: [
        answers([call('say', { text: 'A button.' }), call('answer', { markdown: 'It saves.' })]),
        answers([call('say', { text: 'A book.' }), call('answer', { markdown: 'One chapter.' })]),
      ],
    });
    const text = (n: number): string => {
      const first = h.requests[n].turns[0];
      return first.role === 'user' ? first.parts.flatMap((p) => ('text' in p ? [p.text] : [])).join('\n') : '';
    };
    h.ctl.ask(spot('missing'));
    await flush();
    expect(h.requests[0].tools.map((d) => d.name)).not.toContain('read_file');
    expect(text(0)).not.toContain('Chapter one');
    h.ctl.ask(spot('allin', 1300, 900));
    await flush();
    expect(h.requests[1].tools.map((d) => d.name)).toContain('read_file');
    expect(text(1)).toContain('p. 1:\nChapter one');
  });

  it('serves read_file pages and stops past the budget', async () => {
    // Seven pages of 125,000 characters: an ask reads at most 200 pages x 3,000 = 600,000 of them with read_file.
    const sections = [1, 2, 3, 4, 5, 6, 7].map((n) => ({
      label: `p. ${n}`,
      text: `${[2, 4, 5, 6].includes(n) ? 'Needle' : 'Hay'}${n} ${'.'.repeat(125_000)}`.slice(0, 125_000),
    }));
    const read: string[] = [];
    // What read_file gave, without the reminder to say and answer that follows it.
    const toolText = (turn: Turn | undefined): string => (turn?.role === 'tool'
      ? turn.results.map((r) => { const c = r.content[0]; return c && 'text' in c ? c.text : ''; }).join('')
      : '');
    const reads = (args: unknown, then: RawCall[] = []): Step => async (req, h) => {
      if (req.turns.length > 1) read.push(toolText(req.turns.at(-1)));
      h.accepted();
      return { text: '', calls: args === null ? then : [call('read_file', args, `r${read.length}`)] };
    };
    const h = harness({
      screen: { doc: { name: 'book.pdf', kind: 'pdf', outline: [], sections } },
      steps: [
        reads({ search: 'NEEDLE' }), reads({ pages: '1-2' }), reads({ pages: '7' }),
        reads(null, [call('say', { text: 'Read it.' }), call('answer', { markdown: 'All of it.' })]),
      ],
    });
    h.ctl.ask(spot('allin'));
    await flush();
    expect(h.requests[0].tools.map((d) => d.name)).toContain('read_file');
    expect(read).toHaveLength(3);
    // A search gives the first 3 sections that hold the words, whatever their case.
    expect(read[0]).toContain('p. 2:\nNeedle2');
    expect(read[0]).toContain('p. 4:\nNeedle4');
    expect(read[0]).toContain('p. 5:\nNeedle5');
    expect(read[0]).not.toContain('Needle6');
    // 375,000 read: page 1 fits, page 2 is cut where the budget ends.
    expect(read[1]).toContain('p. 1:\nHay1');
    expect(read[1]).toContain('p. 2:\nNeedle2');
    expect(read[1].endsWith("That's all of the file you can read for this ask.")).toBe(true);
    expect(read[1].length).toBeLessThan(226_000);
    expect(read[2]).toBe("That's all of the file you can read for this ask.");
  });

  it('lists what the answer used in the footer', async () => {
    const seen = 'the quarterly revenue rose by nine percent';
    const sections = [1, 2, 3, 4, 5, 6].map((n) => ({
      label: `p. ${n}`, text: n === 3 ? `${seen} ${'a'.repeat(2_400)}` : `page${n} `.repeat(400),
    }));
    const h = harness({
      screen: {
        system: { selection: 'chosen', spotTexts: [seen], focus: null, address: 'https://example.com/a' },
        marksFile: 'button\t900\t700\t200\t60\tSave\n',
        doc: { name: 'paper.pdf', kind: 'pdf', outline: [], sections },
      },
      steps: [
        answers([call('say', { text: 'Revenue rose.' }), call('answer', { markdown: 'By 9 %.' })]),
        answers([call('say', { text: 'Click Save.' }), call('answer', { markdown: 'Then OK.' })]),
        answers([call('say', { text: 'Still up.' }), call('answer', { markdown: 'Yes.' })]),
      ],
    });
    // Whole picture reads the file; the controls only snap its pings, so they are not named.
    h.ctl.ask(spot('allin'));
    await flush();
    h.ctl.onTeammateAction('bubble', { t: 'more' });
    expect(h.cards().at(-1)?.footer.used).toEqual([
      'screen', 'selection', 'text on screen', 'address', 'paper.pdf p. 1–6',
    ]);

    // Show me how lists the controls in its prompt and reads no file.
    h.ctl.ask(spot('assist', 700, 500));
    await flush();
    h.ctl.onTeammateAction('bubble', { t: 'more' });
    expect(h.cards().at(-1)?.footer.used).toEqual(['screen', 'selection', 'text on screen', 'address', 'controls']);

    // The system text is too slow: the file is still read, and the footer says some context was skipped.
    h.screen.system = 'slow';
    h.ctl.ask(spot('allin', 1300, 900));
    await flush();
    h.ctl.onTeammateAction('bubble', { t: 'more' });
    expect(h.cards().at(-1)?.footer.used).toEqual(['screen', 'paper.pdf p. 1–6', 'some context was skipped']);
  });

  it('finds words past the cut of an oversized section', async () => {
    // One section over 100,000 characters: the prompt gets its first 90,000, read_file the whole of it.
    const text = `${'a '.repeat(50_000)}the hidden clause ${'b '.repeat(1_000)}`;
    let found = '';
    const h = harness({
      screen: { doc: { name: 'contract.txt', kind: 'text', outline: [], sections: [{ label: 'part 1', text }] } },
      steps: [
        answers([call('read_file', { search: 'Hidden Clause' }, 'r')]),
        async (req, hs) => {
          const last = req.turns.at(-1);
          const parts = last?.role === 'tool' ? last.results.flatMap((r) => r.content) : [];
          found = parts.flatMap((c) => ('text' in c ? [c.text] : [])).join('');
          hs.accepted();
          return { text: '', calls: [call('say', { text: 'Found it.' }), call('answer', { markdown: 'There.' })] };
        },
      ],
    });
    h.ctl.ask(spot('allin'));
    await flush();
    const first = h.requests[0].turns[0];
    const prompt = first.role === 'user' ? first.parts.flatMap((p) => ('text' in p ? [p.text] : [])).join('') : '';
    expect(prompt).not.toContain('the hidden clause');
    expect(found).toContain('the hidden clause');
  });

  it('fails an ask whose gathering hangs at the total deadline', async () => {
    const h = harness({ screen: { system: 'hangs' } });
    h.ctl.ask(spot('danger'));
    await flush();
    await vi.advanceTimersByTimeAsync(59_999);
    expect(h.ctl.running).toBe(true);
    expect(h.requests).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.bubbles().map((b) => b.line)).toEqual([t.ask.failed.timeout]);
    expect(h.ctl.running).toBe(false);
  });
});

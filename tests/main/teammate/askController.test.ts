import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunInfo } from '../../../src/main/teammate/actions';
import { AskController, type AskDeps } from '../../../src/main/teammate/askController';
import { ContextError } from '../../../src/main/teammate/contextClient';
import type { Doc } from '../../../src/main/teammate/files';
import type { RawCall, StreamHandlers, Turn, TurnResult } from '../../../src/main/teammate/providers/types';
import { strings } from '../../../src/shared/i18n';
import { DEFAULT_SETTINGS, type Settings } from '../../../src/shared/settings';
import type { Spot } from '../../../src/shared/teammate/askMachine';
import type { SystemTextLayer } from '../../../src/shared/teammate/contextProtocol';
import { receiptPoint, zoomRect, type Rect } from '../../../src/shared/teammate/coords';
import type { ThreadRecord } from '../../../src/shared/teammate/history';
import { intentFor } from '../../../src/shared/teammate/intents';
import { bubbleMs } from '../../../src/shared/teammate/line';
import { DEFAULT_TEAMMATE, type AgentProfile, type BuiltinProfile, type TeammateSettings } from '../../../src/shared/teammate/settings';
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
  /** Wires an action runner that records the calls it is given and says it did `done`. */
  recordActions?: boolean;
  done?: string[];
  /** The helper never says which window is in front. */
  foregroundHangs?: boolean;
  /** The process that owns the window in front; OWN_PID is lolPing's. */
  foregroundPid?: number;
  /** Hears the foreground app of each ask. */
  seenApp?: (app: string) => void;
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

const OWN_PID = 1000;
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
  const takenRuns: RunInfo[] = [];
  let runnerCancels = 0;
  const putClicks: Array<[string, 'bubble' | 'card']> = [];
  const runner = Object.assign(new EventEmitter(), {
    take: (r: RunInfo, c: ActionCall) => {
      takenRuns.push(r);
      taken.push(c);
    },
    put: async (r: RunInfo, from: 'bubble' | 'card') => void putClicks.push([r.id, from]),
    cancel: () => {
      runnerCancels += 1;
    },
    described: () => [...(opts.done ?? [])],
    askAgent: async () => 'deny' as const,
  });
  const dones: Array<{ at: number; done: string[] | undefined }> = [];
  const amends: Array<{ threadId: string; at: number; done: string[] }> = [];
  const states: boolean[] = [];
  let current: ThreadRecord | null = null;
  let captures = 0;
  /** Context reads (gather's helper call). */
  let gathers = 0;
  let skew = 0;
  const popupsAt: Array<{ x: number; y: number }> = [];
  const cardOpens: Array<{ at: { x: number; y: number }; focus: boolean }> = [];
  let bubblePlace: { x: number; y: number } | null = null;
  /** The fake disk: folders and files under the temp folder. */
  const disk = new Set<string>();
  const dirs: string[] = [];
  /** What each thumbnail was made from: the fake files hold their own path. */
  const thumbs: string[] = [];
  const screen: Screen = { system: NO_TEXT, marksFile: '', fields: '', doc: null, boxes: [], ...opts.screen };

  const settings: Settings = {
    ...DEFAULT_SETTINGS,
    teammate: { ...DEFAULT_TEAMMATE, profiles: [profile('fast')], defaultProfile: 'fast', ...opts.teammate },
  };

  const deps: AskDeps = {
    settings: () => settings,
    enabled: () => true,
    lang: () => 'en',
    secrets: {
      available: () => true,
      key: () => (opts.key === undefined ? 'sk-test' : opts.key),
      instructions: () => '',
    },
    context: {
      foreground: async () => (opts.foregroundHangs
        ? new Promise<never>(() => undefined)
        : { app: 'notepad.exe', title: 'notes.txt', window: '263544', pid: opts.foregroundPid ?? 4242 }),
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
        gathers += 1;
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
    ownPid: OWN_PID,
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
      hideBubble: (o) => log.push(['bubbleHidden', o ?? null]),
      hideNow: (view) => log.push(['hiddenNow', view]),
      showCard: (at, s, o) => {
        cardOpens.push({ at, focus: o?.focus ?? false });
        log.push(['card', s]);
      },
      placeOf: () => bubblePlace,
      updateCard: (s) => log.push(['card', s]),
      hideCard: () => log.push(['cardHidden', null]),
      setCaptureExcluded: (on) => log.push(['windowsExcluded', on]),
    },
    history: {
      current: () => current,
      append: async (threadId, entry, meta) => {
        appends.push({ threadId, line: entry.line, markdown: entry.markdown });
        dones.push({ at: entry.at, done: entry.done });
        if (opts.historyOff) {
          return { id: `unsaved${appends.length}`, ...meta, started: 0, lastActivity: 0, entries: [entry] };
        }
        current = threadId !== null && current?.id === threadId
          ? { ...current, entries: [...current.entries, entry] }
          : { id: `t${appends.length}`, ...meta, started: 0, lastActivity: 0, entries: [entry] };
        return current;
      },
      amend: async (threadId, at, done) => void amends.push({ threadId, at, done }),
    },
    tempDir: () => 'tmp',
    thumbnail: (jpeg) => {
      thumbs.push(jpeg.toString());
      return 'thumb';
    },
    now: () => Date.now() + skew,
    usage: () => undefined,
    cursor: () => ({ x: 1200, y: 900 }),
    seenApp: opts.seenApp,
    ...(opts.recordActions ? { actions: runner } : {}),
    files: {
      read: async (p) => Buffer.from(p),
      write: async (p) => void disk.add(p),
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
    ctl, log, requests, signals, adapters, tickets, appends, states, of, popupsAt, disk, dirs, screen, taken, cardOpens,
    dragBubble: (to: { x: number; y: number } | null) => {
      bubblePlace = to;
    },
    takenRuns, runner, dones, amends, putClicks, runnerCancels: () => runnerCancels, thumbs, gathers: () => gathers,
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
    h.ctl.ask([spot('danger')]);
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
    h.ctl.ask([spot('danger')]);
    await flush();
    expect(h.bubbles().map((b) => b.line)).toEqual(['The sum in B4 counts row 3 twice.']);
    expect(h.pings('missing')).toEqual([]);
  });

  it('offers More without asking again when the model gives only a line', async () => {
    const h = harness({
      steps: [answers([call('say', { text: 'Line 3 divides by zero.' }), call('ping', { type: 'danger', spot: 1 }, 'p')])],
    });
    h.ctl.ask([spot('danger')]);
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
    h.ctl.ask([spot('danger')]);
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
    h.ctl.ask([spot('danger')]);
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

  it('gives a bubble the user dragged its reading time again', async () => {
    const h = harness({ steps: [answers([call('say', { text: 'Short.' }), call('answer', { markdown: 'More.' })])] });
    h.ctl.ask([spot('danger')]);
    await flush();
    await vi.advanceTimersByTimeAsync(bubbleMs('Short.') - 100);
    h.ctl.onDragged('bubble');
    await vi.advanceTimersByTimeAsync(bubbleMs('Short.') - 100);
    expect(h.of('bubbleHidden')).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(200);
    expect(h.of('bubbleHidden')).toHaveLength(1);
    // Once it has gone, a late drag report brings nothing back.
    h.ctl.onDragged('bubble');
    await vi.advanceTimersByTimeAsync(bubbleMs('Short.') * 2);
    expect(h.of('bubbleHidden')).toHaveLength(1);
  });

  it('takes the line from the card answer when the model gives only that', async () => {
    const markdown = '- **B4** counts row 3 twice. It should skip it.\n- C2 is empty.';
    const h = harness({ steps: [answers([call('answer', { markdown })])] });
    h.ctl.ask([spot('danger')]);
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
    h.ctl.ask([spot('danger')]);
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
    h.ctl.ask([spot('danger')]);
    await flush();
    expect(h.pings('omw')).toHaveLength(1);

    h.ctl.ask([spot('missing', 2000, 1200)]);
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
      h.ctl.ask([spot('danger')]);
      await flush();
      expect(h.adapters).toEqual([]);
      expect(h.of('capture')).toEqual([]);
      expect(h.pings()).toEqual([expect.objectContaining({ id: 'missing', x: 520, y: 380, tag: TAG })]);
      expect(h.bubbles().map((b) => b.line)).toEqual([t.ask.failed.noProfile]);
      expect(h.ctl.running).toBe(false);
    }
  });

  it('asks for a restart when an agent profile is routed but agents can\'t run', async () => {
    const agent: AgentProfile = {
      id: 'ag', kind: 'agent', name: 'Claude', tagColor: 1, tagColorCustom: null, preset: 'claude', command: 'claude',
      customArgs: [], folder: { kind: 'editor', folders: [] }, timeoutS: 300,
    };
    const h = harness({ teammate: { profiles: [agent], defaultProfile: 'ag' } });
    h.ctl.ask([spot('danger')]);
    await flush();
    expect(h.adapters).toEqual([]);
    expect(h.bubbles().map((b) => b.line)).toEqual([t.ask.agent.noBridge]);
    expect(h.ctl.running).toBe(false);
  });

  it('fails with a line when nothing is received in 10 s', async () => {
    const h = harness({ steps: [hangs({ accept: false })] });
    h.ctl.ask([spot('danger')]);
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

  it('times out when the helper never says which window is in front', async () => {
    const h = harness({ foregroundHangs: true });
    h.ctl.ask([spot('danger')]);
    await flush();
    await vi.advanceTimersByTimeAsync(59_999);
    expect(h.ctl.running).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.ctl.running).toBe(false);
    expect(h.bubbles().map((b) => b.line)).toEqual([t.ask.failed.timeout]);
    expect(h.adapters).toEqual([]);
  });

  it('tells the foreground app of each ask, for the rules card', async () => {
    const apps: string[] = [];
    const h = harness({ seenApp: (app) => apps.push(app) });
    h.ctl.ask([spot('danger')]);
    await flush();
    expect(apps).toEqual(['notepad.exe']);
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
    h.ctl.ask([spot('allin')]);
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
    h.ctl.ask([spot('danger')]);
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
    h.ctl.ask([spot('danger')]);
    await flush();
    expect(h.requests).toHaveLength(2);
  });

  it('continues the thread with push and labels the bubble', async () => {
    const h = harness({
      steps: [
        answers([call('say', { text: 'First answer.' })]), answers([call('say', { text: 'More detail.' })]),
      ],
    });
    h.ctl.ask([spot('missing')]);
    await flush();
    h.ctl.ask([spot('push', 1010, 805)]);
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

  it('gives the card the keyboard when the user opens it from More, and not when it opens by itself', async () => {
    const h = harness({
      steps: [
        answers([call('say', { text: 'A typo.' }), call('answer', { markdown: '**teh** should be **the**' })]),
        answers([call('say', { text: 'A plan.' }), call('answer', { markdown: '## Risks' })]),
      ],
    });
    h.ctl.ask([spot('danger')]);
    await flush();
    h.ctl.onTeammateAction('bubble', { t: 'more' });
    expect(h.cardOpens.at(-1)?.focus).toBe(true);

    h.ctl.ask([spot('allin')]);
    await flush();
    expect(h.cardOpens.at(-1)?.focus).toBe(false);
  });

  it('opens the card where the user dragged the bubble', async () => {
    const h = harness({ steps: [answers([call('say', { text: 'A typo.' }), call('answer', { markdown: 'More.' })])] });
    h.ctl.ask([spot('danger')]);
    await flush();
    h.dragBubble({ x: 700, y: 300 });
    h.ctl.onTeammateAction('bubble', { t: 'more' });
    expect(h.cardOpens.at(-1)?.at).toEqual({ x: 700, y: 300 });
  });

  it('opens the card by itself for Whole picture', async () => {
    const h = harness({
      teammate: { profiles: [profile('fast'), profile('deep')], defaultProfile: 'fast', deepProfile: 'deep' },
      steps: [answers([
        call('say', { text: 'A plan with two risks.' }),
        call('answer', { markdown: '## Risks\n- cost' }),
      ])],
    });
    h.ctl.ask([spot('allin')]);
    await flush();
    expect(h.adapters).toEqual(['deep']);
    const card = h.cards().at(-1);
    expect(card?.entries.at(-1)).toEqual({
      kind: 'answer', label: 'AI', line: 'A plan with two risks.', markdown: '## Risks\n- cost',
    });
    expect(card?.footer).toEqual({
      profile: 'deep', model: 'deep-model', route: t.ask.route.deep, tokens: 120, used: [t.ask.usedScreen],
    });
    expect(h.requests[0].model).toBe('deep-model');
  });

  it('asks the profile an app rule names', async () => {
    const h = harness({
      teammate: {
        profiles: [profile('fast'), profile('code')], defaultProfile: 'fast',
        rules: [{ app: 'Notepad.exe', titleContains: 'notes', intents: ['danger'], profile: 'code' }],
      },
      steps: [answers([call('say', { text: 'A typo.' })]), answers([call('say', { text: 'Fine.' })])],
    });
    h.ctl.ask([spot('danger')]);
    await flush();
    expect(h.adapters).toEqual(['code']);
    expect(h.requests[0].model).toBe('code-model');

    // The rule names Danger only: another intent in the same window goes the default way.
    h.ctl.ask([spot('push')]);
    await flush();
    expect(h.adapters).toEqual(['code', 'fast']);
  });

  it('shows why the profile was chosen in the card footer', async () => {
    const answer = () => answers([call('say', { text: 'A plan.' }), call('answer', { markdown: '## Risks' })]);
    const h = harness({
      teammate: {
        profiles: [profile('fast'), profile('deep'), profile('code')], defaultProfile: 'fast', deepProfile: 'deep',
        rules: [{ app: 'notepad.exe', titleContains: '', intents: ['danger'], profile: 'code' }],
      },
      steps: [answer(), answer(), answer()],
    });
    const routes = async (intent: Spot['intent']) => {
      h.ctl.ask([spot(intent)]);
      await flush();
      h.ctl.onTeammateAction('bubble', { t: 'more' });
      return h.cards().at(-1)?.footer.route;
    };
    expect(await routes('danger')).toBe('Rule: notepad.exe');
    expect(await routes('allin')).toBe('Deep profile');
    expect(await routes('push')).toBe('Default');
  });

  it('clears everything on pause', async () => {
    const h = harness({ steps: [hangs({ accept: true })] });
    h.ctl.ask([spot('danger')]);
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
    h.ctl.ask([spot('assist')]);
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
      h.ctl.ask([spot('danger')]);
      await flush();
      expect(h.pings('danger')).toEqual([expect.objectContaining({ keep: true })]);
      expect(h.of('emote')).toEqual([expect.objectContaining({ slug: 'facepalm', keep: true })]);
    });

    it('keeps the teammate pings while the card is open', async () => {
      const h = withCard();
      h.ctl.ask([spot('danger')]);
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
      h.ctl.ask([spot('danger')]);
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
      h.ctl.ask([spot('danger')]);
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
      h.ctl.ask([spot('danger')]);
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
      h.ctl.ask([spot('danger')]);
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
      h.ctl.ask([spot('danger')]);
      await flush();
      h.ctl.ask([spot('danger', 1200, 900)]);
      await flush();
      expect(h.of('clear')).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(h.of('fade')).toHaveLength(0);
    });

    it('clears the pings on a pause even with the card open', async () => {
      const h = withCard();
      h.ctl.ask([spot('danger')]);
      await flush();
      h.ctl.onTeammateAction('bubble', { t: 'more' });
      h.ctl.cancel('pause');
      expect(h.of('clear')).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(h.of('fade')).toHaveLength(0);
    });

    it('keeps the missing ping of a failed ask for the same time', async () => {
      const h = harness({ steps: [hangs({ accept: false })] });
      h.ctl.ask([spot('danger')]);
      await flush();
      await vi.advanceTimersByTimeAsync(10_000); // not received
      expect(h.pings('missing')).toEqual([expect.objectContaining({ keep: true })]);
      await vi.advanceTimersByTimeAsync(14_999);
      expect(h.of('fade')).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(1);
      expect(h.of('fade')).toHaveLength(1);
    });
  });

  describe('when the page under the marks moves', () => {
    const answered = () => harness({
      steps: [answers([
        call('say', { text: 'Line 3 divides by zero.' }),
        call('answer', { markdown: 'B3 is 0, so =A3/B3 fails.' }),
        call('ping', { type: 'danger', x: 600, y: 400 }, 'p'),
        call('emote', { slug: 'facepalm', x: 200, y: 100 }, 'e'),
      ])],
    });
    const watching = (h: ReturnType<typeof harness>): unknown[] => {
      const seen: unknown[] = [];
      h.ctl.on('watch', (w: unknown) => seen.push(w));
      return seen;
    };

    it('fades marks and bubble on stale and keeps the card', async () => {
      const h = answered();
      h.ctl.ask([spot('danger')]);
      await flush();
      h.ctl.stale();
      expect(h.of('fade')).toHaveLength(1);
      expect(h.of('clear')).toHaveLength(0);
      expect(h.of('bubbleHidden')).toEqual([{ stale: true }]);
      // The usual fade finds nothing left to fade.
      await vi.advanceTimersByTimeAsync(60_000);
      expect(h.of('fade')).toHaveLength(1);
      expect(h.of('bubbleHidden')).toHaveLength(1);

      const c = answered();
      c.ctl.ask([spot('danger')]);
      await flush();
      c.ctl.onTeammateAction('bubble', { t: 'more' });
      c.ctl.stale();
      expect(c.of('fade')).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(c.of('cardHidden')).toHaveLength(0);
      expect(c.of('fade')).toHaveLength(1);
    });

    it('draws no more pings of an ask that went stale', async () => {
      let finish: (r: TurnResult) => void = () => undefined;
      const say = call('say', { text: 'Line 3 divides by zero.' });
      const slow: Step = (_req, s) => {
        s.accepted();
        s.call?.(say);
        return new Promise((resolve) => { finish = resolve; });
      };
      const h = harness({ steps: [slow] });
      const watches = watching(h);
      h.ctl.ask([spot('danger')]);
      await flush();
      expect(h.pings('omw')).toHaveLength(1);
      h.ctl.stale();
      expect(watches).toEqual([{ window: '263544' }, null]);

      finish({
        text: '', calls: [
          say,
          call('ping', { type: 'danger', x: 600, y: 400 }, 'p'),
          call('emote', { slug: 'facepalm', x: 200, y: 100 }, 'e'),
          call('say', { text: 'B4 is empty too.' }, 's2'),
        ],
      });
      await flush();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(h.pings('danger')).toEqual([]);
      expect(h.of('emote')).toEqual([]);
      // The answer still comes: a later say brings its line back, and that bubble isn't watched again.
      expect(h.popupsAt).toHaveLength(2);
      expect(h.bubbles().at(-1)).toEqual(expect.objectContaining({ line: 'Line 3 divides by zero.', more: true }));
      expect(watches).toEqual([{ window: '263544' }, null]);
      expect(h.of('fade')).toHaveLength(1);
    });

    /** An ask whose answer streams says one by one, while the test sends them. */
    const streaming = () => {
      let handlers: StreamHandlers | null = null;
      const slow: Step = (_req, s) => {
        s.accepted();
        handlers = s;
        return new Promise(() => undefined);
      };
      const h = harness({ steps: [slow] });
      let n = 0;
      const say = async (text: string): Promise<void> => {
        n += 1;
        handlers?.call?.(call('say', { text }, `s${n}`));
        await flush();
      };
      return { h, say };
    };

    it('brings back only a bubble that went stale, once', async () => {
      const { h, say } = streaming();
      h.ctl.ask([spot('danger')]);
      await flush();
      await say('Line 3 divides by zero.');
      h.ctl.stale();
      await say('B4 is empty too.');
      expect(h.popupsAt).toHaveLength(2);
      h.ctl.onTeammateAction('bubble', { t: 'dismiss' });
      await say('And C2.');
      expect(h.popupsAt).toHaveLength(2);
    });

    it('keeps a bubble the user dismissed before the page moved down', async () => {
      const { h, say } = streaming();
      h.ctl.ask([spot('danger')]);
      await flush();
      await say('Line 3 divides by zero.');
      h.ctl.onTeammateAction('bubble', { t: 'dismiss' });
      h.ctl.stale();
      await say('B4 is empty too.');
      expect(h.popupsAt).toHaveLength(1);
    });

    it('keeps a card the user closed after the page moved closed', async () => {
      const { h, say } = streaming();
      h.ctl.ask([spot('danger')]);
      await flush();
      await say('Line 3 divides by zero.');
      h.ctl.onTeammateAction('bubble', { t: 'more' });
      h.ctl.stale();
      h.ctl.onTeammateAction('card', { t: 'close' });
      await say('B4 is empty too.');
      expect(h.popupsAt).toHaveLength(1);
      expect(h.cardOpens).toHaveLength(1);
    });

    it('keeps a bubble hidden for a paste down', async () => {
      const { h, say } = streaming();
      h.ctl.ask([spot('danger')]);
      await flush();
      await say('Line 3 divides by zero.');
      h.ctl.stale();
      await say('B4 is empty too.'); // the line came back
      h.ctl.hideBubbleForPut();
      await say('And C2.');
      expect(h.popupsAt).toHaveLength(2);

      const before = streaming();
      before.h.ctl.ask([spot('danger')]);
      await flush();
      await before.say('Line 3 divides by zero.');
      before.h.ctl.hideBubbleForPut();
      before.h.ctl.stale();
      await before.say('B4 is empty too.');
      expect(before.h.popupsAt).toHaveLength(1);
    });

    it('drops the pings still waiting their turn', async () => {
      const h = harness({
        steps: [answers([
          call('say', { text: 'Three things.' }),
          call('ping', { type: 'danger', x: 600, y: 400 }, 'p1'),
          call('ping', { type: 'danger', x: 700, y: 400 }, 'p2'),
          call('ping', { type: 'danger', x: 800, y: 400 }, 'p3'),
        ])],
      });
      h.ctl.ask([spot('danger')]);
      await flush();
      expect(h.pings('danger')).toHaveLength(1);
      h.ctl.stale();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(h.pings('danger')).toHaveLength(1);
    });

    it('watches while its marks or bubble are up', async () => {
      const h = harness({
        steps: [
          answers([call('say', { text: 'Short.' }), call('ping', { type: 'danger', x: 600, y: 400 })]),
          answers([call('say', { text: 'Two.' }), call('ping', { type: 'danger', x: 600, y: 400 })]),
          hangs({ accept: true }),
        ],
      });
      const watches = watching(h);
      h.ctl.ask([spot('danger')]);
      await flush();
      expect(watches).toEqual([{ window: '263544' }]);
      await vi.advanceTimersByTimeAsync(bubbleMs('Short.') + 1_000); // the bubble went, the marks stay
      expect(watches).toEqual([{ window: '263544' }]);
      await vi.advanceTimersByTimeAsync(15_000);
      expect(watches).toEqual([{ window: '263544' }, null]);

      // A new ask while the last one's marks are up watches again from its own start.
      h.ctl.ask([spot('danger')]);
      await flush();
      h.ctl.ask([spot('danger', 1200, 900)]);
      await flush();
      expect(watches).toEqual([{ window: '263544' }, null, { window: '263544' }, null, { window: '263544' }]);
      h.ctl.cancel('user');
      expect(watches.at(-1)).toBeNull();
    });

    it('watches with no window when the ask was made from lolPing\'s own window', async () => {
      const h = harness({
        foregroundPid: OWN_PID, // the card's reply box had the keyboard
        steps: [answers([call('say', { text: 'Short.' }), call('ping', { type: 'danger', x: 600, y: 400 })])],
      });
      const watches = watching(h);
      h.ctl.ask([spot('danger')]);
      await flush();
      expect(watches).toEqual([{ window: '' }]);
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
    h.ctl.ask([spot('generic')]);
    await flush();
    await vi.advanceTimersByTimeAsync(2000);
    expect(h.pings('generic')).toEqual([{ displayId: 1, x: 500, y: 400, id: 'generic', keep: true, tag: TAG }]);
  });

  it('shows only the dots on a tag for a Do it ask, and is silent when the receipt sound is off', async () => {
    const h = harness({ teammate: { receiptSound: false }, steps: [hangs({ accept: true })] });
    h.ctl.ask([spot('omw')]);
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
    h.ctl.ask([spot('danger')]);
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
      h.ctl.ask([spot('danger')]);
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
    h.ctl.ask([spot('missing')]);
    await flush();
    h.ctl.ask([spot('push', 1010, 805)]);
    await flush();
    h.ctl.cancel('pause'); // a pause clears the screen but not the thread
    h.ctl.ask([spot('push', 1500, 900)]);
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
      entries: [{ at: 0, intent: 'missing', words: null, line: 'Long ago.', markdown: '', thumb: '', spots: 1 }],
    };
    h.ctl.continueThread(picked);
    h.ctl.ask([spot('push')]);
    await flush();
    expect(h.bubbles().map((b) => b.thread)).toEqual(['Old thread']);
    expect(h.appends.map((a) => a.threadId)).toEqual(['old']);
  });

  it('opens a thread from History as a card, and a reply in it continues that thread at the cursor', async () => {
    const h = harness({ steps: [answers([call('say', { text: 'Still there.' })])] });
    const picked: ThreadRecord = {
      id: 'old', title: 'Old thread', started: 0, lastActivity: 0, app: '', windowTitle: '', profile: 'fast',
      entries: [{ at: 0, intent: 'missing', words: null, line: 'Long ago.', markdown: '', thumb: '', spots: 1 }],
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
    h.ctl.ask([spot('danger')]);
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
    h.ctl.ask([spot('danger')]);
    await flush();
    const held = h.ctl.currentThread()?.id;
    expect(held).toBeDefined();
    h.ctl.forgetThread('another-id');
    expect(h.ctl.currentThread()?.id).toBe(held);
    h.ctl.forgetThread(); // History was cleared
    h.ctl.ask([spot('push')]);
    await flush();
    expect(h.appends.map((a) => a.threadId)).toEqual([null, null]);
  });

  it('looks once per ask and stops after 6 rounds', async () => {
    const look = (n: number) => answers([call('look', { x: 500, y: 300, w: 200, h: 150 }, `l${n}`)]);
    const h = harness({ steps: [1, 2, 3, 4, 5, 6, 7].map(look) });
    h.ctl.ask([spot('allin')]);
    await flush();
    expect(h.requests).toHaveLength(6);
    expect(h.of('capture')).toHaveLength(2); // the ask's own capture and the first look
    expect(h.requests[0].tools.map((d) => d.name)).toContain('look');
    expect(h.requests[1].tools.map((d) => d.name)).not.toContain('look');
    expect(h.ctl.running).toBe(false);
  });

  it('offers look only to Show me how and Whole picture', async () => {
    const h = harness({ steps: [answers([call('say', { text: 'A.' })]), answers([call('say', { text: 'B.' })])] });
    h.ctl.ask([spot('missing')]);
    await flush();
    h.ctl.ask([spot('assist', 1300, 900)]);
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
    h.ctl.ask([spot('missing')]);
    await flush();
    expect(h.of('framed')).toEqual([{
      area: { x: 100, y: 100, w: 1700, h: 1100 }, crops: [{ x: 584, y: 584, w: 932, h: 432 }],
    }]);
    // The overview's pixels now map onto the window, not the display.
    const first = h.requests[0].turns[0];
    const text = first.role === 'user' ? first.parts.flatMap((p) => ('text' in p ? [p.text] : [])).join('\n') : '';
    expect(text).toContain('spot 1 is at x=847, y=636 in the overview.');
  });

  it('captures one close-up per spot and lists every spot to the model', async () => {
    const h = harness({ steps: [answers([call('say', { text: 'Both prices are off.' })])] });
    const spots = [spot('missing', 1000, 800), spot('missing', 2000, 1200), spot('danger', 1500, 900)];
    h.ctl.ask(spots);
    await flush();
    expect(h.of('capture')).toEqual([spots.map((s) => s.phys)]);
    expect(h.of('framed')).toEqual([{ area: DISPLAY, crops: spots.map((s) => zoomRect(DISPLAY, s.phys)) }]);
    const req = h.requests[0];
    const first = req.turns[0];
    const parts = first.role === 'user' ? first.parts : [];
    const text = parts.flatMap((p) => ('text' in p ? [p.text] : [])).join('\n');
    expect(text).toContain('spot 1 is at x=500, y=400 in the overview.');
    expect(text).toContain('spot 2 is at x=1000, y=600 in the overview.');
    expect(text).toContain('spot 3 is at x=750, y=450 in the overview.');
    expect(text).toContain('The user marked 3 spots, in this order.');
    expect(parts.filter((p) => 'image' in p)).toHaveLength(4); // the overview and a close-up of each spot
    expect(JSON.stringify(req.tools)).toContain('The user marked 3 spots.');
    // The last spot's intent decides the question.
    expect(req.system).toContain("The task: What's wrong.");
    expect(h.ctl.currentThread()?.entries.map((e) => e.spots)).toEqual([3]);
    expect(h.thumbs).toEqual(['zoom1-2.jpg']); // the last spot's close-up: the ask sits there
    h.ctl.onTeammateAction('bubble', { t: 'more' });
    expect(h.cards().at(-1)?.entries[0].label).toBe(`${intentFor(DEFAULT_TEAMMATE, 'danger', 'en').label} · 3 spots`);
  });

  it('places the receipt and bubble at the last spot', async () => {
    const h = harness({
      steps: [
        answers([call('say', { text: 'Both.' }), call('answer', { markdown: 'More.' })]), hangs({ accept: true }),
      ],
    });
    const last = spot('missing', 2000, 1200);
    h.ctl.ask([spot('missing', 1000, 800), last]);
    await flush();
    const receipt = receiptPoint(last.phys, DISPLAY);
    expect(h.pings('omw')).toEqual([expect.objectContaining({ x: receipt.x / 2, y: receipt.y / 2 })]);
    expect(h.popupsAt).toEqual([{ x: receipt.x / 2 + 24, y: receipt.y / 2 - 24 }]);
    // A reply from the card asks at the last spot alone.
    h.ctl.onTeammateAction('bubble', { t: 'more' });
    h.ctl.onTeammateAction('card', { t: 'reply', text: 'and the third?' });
    await flush();
    expect(h.of('capture')).toEqual([[{ x: 1000, y: 800 }, last.phys], [last.phys]]);
  });

  it('lets the model point at spot 2', async () => {
    const h = harness({
      steps: [answers([
        call('ping', { type: 'generic', spot: 2 }, 'a'),
        call('ping', { type: 'generic', spot: 3 }, 'b'),
        call('say', { text: 'This one.' }),
      ])],
    });
    h.ctl.ask([spot('missing', 1000, 800), spot('missing', 2000, 1200)]);
    await flush();
    await vi.advanceTimersByTimeAsync(2000);
    expect(h.pings('generic')).toEqual([{ displayId: 1, x: 1000, y: 600, id: 'generic', keep: true, tag: TAG }]);
  });

  it('lets the overlays and windows back into captures when a capture throws', async () => {
    const h = harness({ captureThrows: true });
    h.ctl.ask([spot('danger')]);
    await flush();
    expect(h.of('overlaysExcluded')).toEqual([true, false]);
    expect(h.of('windowsExcluded')).toEqual([true, false]);
    expect(h.bubbles().map((b) => b.line)).toEqual([t.ask.failed.capture]);
  });

  it('shows the line on the primary display when no display is under the spot', async () => {
    const h = harness({ noDisplay: true });
    h.ctl.ask([spot('danger')]);
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
    h.ctl.ask([spot('danger')]);
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
    h.ctl.ask([spot('danger')]);
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
      h.ctl.ask([spot('missing')]);
      await flush();
      h.ctl.ask([spot('enemyvision', 1300, 900)]);
      await flush();
      h.ctl.ask([spot('omw', 1500, 900)]);
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
      h.ctl.ask([spot('omw')]);
      await flush();
      h.ctl.ask([spot('missing', 1500, 900)]);
      await flush();
      expect(h.requests[0].tools.map((d) => d.name)).toContain('fill');
      const first = h.requests[0].turns[0];
      const text = first.role === 'user' ? first.parts.map((p) => ('text' in p ? p.text : '')).join('\n') : '';
      expect(text).toContain('42.7.1 | text | Customer name |');
      expect(text).toContain('42.7.2 | text | Password | secure, never fill |');
      expect(text).not.toContain('hunter2');
      expect(h.requests[1].tools.map((d) => d.name)).not.toContain('fill');
    });

    it('hands each valid action call to the runner once and tells the model which wait for the user', async () => {
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
      h.ctl.ask([spot('omw')]);
      await flush();
      expect(h.taken).toEqual([
        { tool: 'paste', text: 'Friday works.', mode: 'insert' },
        { tool: 'copy', text: 'Friday works.' },
        { tool: 'open', url: 'https://example.com' },
      ]);
      // A copy is done at once; a paste or an open waits for the user, and the model must not take it as done.
      const done = [{ text: 'Done.' }];
      const asked = [{ text: 'Asked the user; it happens if they agree.' }];
      expect(results(second).map((r) => r.content)).toEqual([asked, done, asked, done, [{ text: 'Not available.' }]]);
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
      h.ctl.ask([spot('missing')]);
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
      h.ctl.ask([spot('omw')]);
      await flush();
      expect(h.taken).toEqual([{ tool: 'paste', text: 'one', mode: 'insert' }]);
      expect(results(second).map((r) => r.id)).toEqual(['p1', 'p2', 'f']);
      expect(JSON.stringify(results(second)[1].content)).toContain('Ignored');
    });

    it('hands action calls to the runner', async () => {
      const box = { x: 900, y: 780, w: 400, h: 40 };
      const fields = JSON.stringify({
        id: '42.7.1', kind: 'text', label: 'Reply', group: '', value: '', secure: false, required: false, options: [],
        box: '900,780,400,40',
      });
      const h = harness({
        recordActions: true,
        steps: [answers([call('paste', { text: 'Friday works.', mode: 'replace' }), call('say', { text: 'Ok.' })])],
        screen: {
          system: {
            selection: 'teh text', spotTexts: [], address: '',
            focus: { kind: 'field', label: 'Reply', value: 'teh text', secure: false },
          },
          boxes: [box, DISPLAY],
          fields,
        },
      });
      h.ctl.ask([spot('omw')]);
      await flush();
      expect(h.taken).toEqual([{ tool: 'paste', text: 'Friday works.', mode: 'replace' }]);
      expect(h.takenRuns).toEqual([{
        id: h.tickets[0], profileId: 'fast', profileName: 'fast', tag: TAG, app: 'notepad.exe', window: '263544',
        lang: 'en',
        spot: { x: 1000, y: 800 }, at: { x: 500, y: 400 }, box,
        focus: { kind: 'field', label: 'Reply', value: 'teh text', secure: false },
        selection: 'teh text',
        fields: [{
          id: '42.7.1', kind: 'text', label: 'Reply', group: '', value: '', secure: false, required: false, options: [],
          box,
        }],
        cwd: null,
      }]);
      // A new ask, or a pause, drops whatever is still waiting for consent.
      const before = h.runnerCancels();
      h.ctl.ask([spot('danger', 1500, 900)]);
      expect(h.runnerCancels()).toBe(before + 1);
      h.ctl.cancel('pause');
      expect(h.runnerCancels()).toBe(before + 2);
    });

    it('keeps the bubble and its button while a consent card waits, then gives it its time again', async () => {
      const h = harness({
        recordActions: true,
        steps: [answers([call('say', { text: 'Ok.' }), call('paste', { text: 'Friday works.', mode: 'insert' })])],
      });
      h.ctl.ask([spot('omw')]);
      await flush();
      h.runner.emit('put', 'paste');
      h.runner.emit('asking', true);
      await vi.advanceTimersByTimeAsync(bubbleMs('Ok.') * 3);
      expect(h.of('bubbleHidden')).toHaveLength(0);
      // Declined: the line and its Paste button stay for the line's whole time.
      h.runner.emit('asking', false);
      await vi.advanceTimersByTimeAsync(bubbleMs('Ok.') - 100);
      expect(h.of('bubbleHidden')).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(200);
      expect(h.of('bubbleHidden')).toHaveLength(1);
    });

    it('shows Paste when ready after hands stayed on the keys', async () => {
      const h = harness({
        recordActions: true,
        steps: [answers([call('paste', { text: 'Friday works.', mode: 'insert' }), call('say', { text: 'Ok.' })])],
      });
      h.ctl.ask([spot('omw')]);
      await flush();
      expect(h.bubbles().at(-1)?.put).toBeNull();
      // The runner took the paste: the bubble offers it.
      h.runner.emit('put', 'paste');
      expect(h.bubbles().at(-1)).toEqual(expect.objectContaining({ line: 'Ok.', put: 'paste' }));
      // A click paste hides the bubble first, at once, with no leave motion; the helper then answers `hands`.
      h.ctl.hideBubbleForPut();
      expect(h.of('hiddenNow')).toEqual(['bubble']);
      expect(h.of('bubbleHidden')).toHaveLength(0);
      const shown = h.of('bubble').length;
      h.runner.emit('put', 'ready');
      // The bubble comes back, so Paste when ready has somewhere to be.
      expect(h.of('bubble')).toHaveLength(shown + 1);
      expect(h.bubbles().at(-1)).toEqual(expect.objectContaining({ line: 'Ok.', put: 'ready' }));
      expect(h.popupsAt).toHaveLength(2);
      // Its click is the consent, for this ask.
      h.ctl.onTeammateAction('bubble', { t: 'put' });
      expect(h.putClicks).toEqual([[h.tickets[0], 'bubble']]);
      // The paste landed: the button goes, the bubble stays.
      h.runner.emit('put', null);
      expect(h.bubbles().at(-1)?.put).toBeNull();
      expect(h.of('bubbleHidden')).toHaveLength(0);
      expect(h.of('hiddenNow')).toHaveLength(1);

      // With the card up, the card carries the button and the bubble stays away.
      h.ctl.onTeammateAction('bubble', { t: 'more' });
      const bubbles = h.of('bubble').length;
      h.runner.emit('put', 'replace');
      expect(h.cards().at(-1)?.put).toBe('replace');
      expect(h.of('bubble')).toHaveLength(bubbles);
      h.ctl.onTeammateAction('card', { t: 'put' });
      expect(h.putClicks.at(-1)).toEqual([h.tickets[0], 'card']);
    });

    it('brings back only a bubble the paste hid, never one the user closed or whose time ran out', async () => {
      const steps = (): Parameters<typeof harness>[0] => ({
        recordActions: true,
        steps: [answers([call('paste', { text: 'Friday works.', mode: 'insert' }), call('say', { text: 'Ok.' })])],
      });
      const closed = harness(steps());
      closed.ctl.ask([spot('omw')]);
      await flush();
      closed.runner.emit('put', 'paste');
      closed.ctl.onTeammateAction('bubble', { t: 'dismiss' });
      const shown = closed.of('bubble').length;
      closed.runner.emit('put', 'ready');
      expect(closed.of('bubble')).toHaveLength(shown);

      const ran = harness(steps());
      ran.ctl.ask([spot('omw')]);
      await flush();
      await vi.advanceTimersByTimeAsync(bubbleMs('Ok.'));
      expect(ran.of('bubbleHidden')).toHaveLength(1);
      const before = ran.of('bubble').length;
      ran.runner.emit('put', 'paste');
      expect(ran.of('bubble')).toHaveLength(before);

      // Hidden for the paste, then closed by the user before the reply: it stays closed.
      const both = harness(steps());
      both.ctl.ask([spot('omw')]);
      await flush();
      both.ctl.hideBubbleForPut();
      both.ctl.cancel('pause');
      const after = both.of('bubble').length;
      both.runner.emit('put', 'ready');
      expect(both.of('bubble')).toHaveLength(after);
    });

    it('brings the bubble back with the button when a paste closed the card that had focus', async () => {
      const h = harness({
        recordActions: true,
        steps: [answers([call('paste', { text: 'Friday works.', mode: 'insert' }), call('say', { text: 'Ok.' })])],
      });
      h.ctl.ask([spot('omw')]);
      await flush();
      h.ctl.onTeammateAction('bubble', { t: 'more' });
      h.ctl.hideCardForPut();
      expect(h.of('cardHidden')).toHaveLength(1);
      h.runner.emit('put', 'ready');
      expect(h.bubbles().at(-1)).toEqual(expect.objectContaining({ line: 'Ok.', put: 'ready' }));

      // A card the user closed stays closed, and brings no bubble.
      const user = harness({
        recordActions: true,
        steps: [answers([call('paste', { text: 'Friday works.', mode: 'insert' }), call('say', { text: 'Ok.' })])],
      });
      user.ctl.ask([spot('omw')]);
      await flush();
      user.ctl.onTeammateAction('bubble', { t: 'more' });
      user.ctl.onTeammateAction('card', { t: 'close' });
      const shown = user.of('bubble').length;
      user.runner.emit('put', 'ready');
      expect(user.of('bubble')).toHaveLength(shown);
    });

    it('gives the bubble its reading time again when it gets a put button', async () => {
      const h = harness({
        recordActions: true,
        steps: [answers([call('paste', { text: 'Friday works.', mode: 'insert' }), call('say', { text: 'Ok.' })])],
      });
      h.ctl.ask([spot('omw')]);
      await flush();
      await vi.advanceTimersByTimeAsync(bubbleMs('Ok.') - 500);
      h.runner.emit('put', 'ready');
      await vi.advanceTimersByTimeAsync(bubbleMs('Ok.') - 1);
      expect(h.of('bubbleHidden')).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(1);
      expect(h.of('bubbleHidden')).toHaveLength(1);
    });

    it('sends no put click for an answer that has no action', async () => {
      const h = harness({ recordActions: true, steps: [answers([call('say', { text: 'Ok.' })])] });
      h.ctl.ask([spot('enemyvision')]);
      await flush();
      h.ctl.onTeammateAction('bubble', { t: 'put' });
      expect(h.putClicks).toEqual([]);
      // Nothing to offer: a cleared button brings no bubble back.
      h.ctl.onTeammateAction('bubble', { t: 'dismiss' });
      const shown = h.of('bubble').length;
      h.runner.emit('put', null);
      expect(h.of('bubble')).toHaveLength(shown);
    });

    it('keeps a description of what was done in history, not the text', async () => {
      const h = harness({
        recordActions: true,
        done: ['Copied 1 line'],
        steps: [answers([call('copy', { text: 'Friday works.' }), call('say', { text: 'Copied your reply.' })])],
      });
      h.ctl.ask([spot('enemyvision')]);
      await flush();
      expect(h.dones).toEqual([{ at: expect.any(Number), done: ['Copied 1 line'] }]);
      expect(JSON.stringify(h.dones)).not.toContain('Friday works.');
      // A paste allowed after the answer was written joins its entry.
      h.runner.emit('described', h.tickets[0], ['Copied 1 line', 'Pasted 1 line into notepad.exe']);
      h.runner.emit('described', 'another ask', ['Opened a link']);
      await flush();
      expect(h.amends).toEqual([
        { threadId: 't1', at: h.dones[0].at, done: ['Copied 1 line', 'Pasted 1 line into notepad.exe'] },
      ]);

      // Nothing done: the entry has no list.
      const quiet = harness({ recordActions: true, steps: [answers([call('say', { text: 'Ok.' })])] });
      quiet.ctl.ask([spot('enemyvision')]);
      await flush();
      expect(quiet.dones).toEqual([{ at: expect.any(Number), done: undefined }]);
    });

    it('keeps action calls without a runner and still answers', async () => {
      const h = harness({
        steps: [answers([call('copy', { text: 'x' }, 'c'), call('say', { text: 'Grabbed it.' }, 's')])],
      });
      h.ctl.ask([spot('enemyvision')]);
      await flush();
      expect(h.bubbles().some((b) => JSON.stringify(b).includes('Grabbed it.'))).toBe(true);
      expect(toolNames(h)).toContain('copy');
    });
  });

  it('removes the run folder even when the ask is cancelled while the capture runs', async () => {
    const h = harness({ captureHangs: true });
    h.ctl.ask([spot('danger')]);
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
    h.ctl.ask([spot('danger')]);
    await flush();
    expect(h.dirs).toHaveLength(1);
    expect([...h.disk]).toEqual([]);
  });

  it('captures and sends images for every model, whatever its name', async () => {
    const h = harness({
      teammate: { profiles: [{ ...profile('fast'), model: 'deepseek-chat' }] },
      steps: [answers([call('say', { text: 'Fine.' })])],
    });
    h.ctl.ask([spot('allin')]);
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
    h.ctl.ask([spot('assist')]);
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
    h.ctl.ask([spot('danger')]);
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
    h.ctl.ask([spot('missing')]);
    await flush();
    expect(h.requests[0].tools.map((d) => d.name)).not.toContain('read_file');
    expect(text(0)).not.toContain('Chapter one');
    h.ctl.ask([spot('allin', 1300, 900)]);
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
    h.ctl.ask([spot('allin')]);
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
    h.ctl.ask([spot('allin')]);
    await flush();
    h.ctl.onTeammateAction('bubble', { t: 'more' });
    expect(h.cards().at(-1)?.footer.used).toEqual([
      'screen', 'selection', 'text on screen', 'address', 'paper.pdf p. 1–6',
    ]);

    // Show me how lists the controls in its prompt and reads no file.
    h.ctl.ask([spot('assist', 700, 500)]);
    await flush();
    h.ctl.onTeammateAction('bubble', { t: 'more' });
    expect(h.cards().at(-1)?.footer.used).toEqual(['screen', 'selection', 'text on screen', 'address', 'controls']);

    // The system text is too slow: the file is still read, and the footer says some context was skipped.
    h.screen.system = 'slow';
    h.ctl.ask([spot('allin', 1300, 900)]);
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
    h.ctl.ask([spot('allin')]);
    await flush();
    const first = h.requests[0].turns[0];
    const prompt = first.role === 'user' ? first.parts.flatMap((p) => ('text' in p ? [p.text] : [])).join('') : '';
    expect(prompt).not.toContain('the hidden clause');
    expect(found).toContain('the hidden clause');
  });

  it('fails an ask whose gathering hangs at the total deadline', async () => {
    const h = harness({ screen: { system: 'hangs' } });
    h.ctl.ask([spot('danger')]);
    await flush();
    await vi.advanceTimersByTimeAsync(59_999);
    expect(h.ctl.running).toBe(true);
    expect(h.requests).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.bubbles().map((b) => b.line)).toEqual([t.ask.failed.timeout]);
    expect(h.ctl.running).toBe(false);
  });

  it('sends to the model as soon as the key comes up after a read-ahead', async () => {
    const h = harness({ steps: [answers([call('say', { text: 'Fine.' })])] });
    const spots = [spot('danger', 1000, 800), spot('missing', 2000, 1200)];
    h.ctl.prepare(spots);
    await flush();
    expect(h.of('capture')).toHaveLength(1);
    expect(h.gathers()).toBe(1);
    expect(h.requests).toEqual([]);
    expect(h.ctl.running).toBe(false);

    h.ctl.ask(spots);
    await flush();
    expect(h.requests).toHaveLength(1);
    expect(h.of('capture')).toHaveLength(1);
    expect(h.gathers()).toBe(1);
    expect(h.bubbles().map((b) => b.line)).toEqual(['Fine.']);
    expect([...h.disk]).toEqual([]);
  });

  it('starts the ask\'s clocks at the key-up, not at the read-ahead', async () => {
    const h = harness({ steps: [hangs({ accept: false })] });
    h.ctl.prepare([spot('danger')]);
    await flush();
    await vi.advanceTimersByTimeAsync(55_000);
    h.ctl.ask([spot('danger')]);
    await flush();
    await vi.advanceTimersByTimeAsync(9_999);
    expect(h.ctl.running).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.bubbles().map((b) => b.line)).toEqual([t.ask.failed.notReceived]);
  });

  it('reads again when the spots changed after the read-ahead', async () => {
    const h = harness({ steps: [answers([call('say', { text: 'Fine.' })])] });
    h.ctl.prepare([spot('danger', 1000, 800)]);
    await flush();
    h.ctl.ask([spot('danger', 1000, 800), spot('missing', 2000, 1200)]);
    await flush();
    expect(h.of('capture')).toEqual([[{ x: 1000, y: 800 }], [{ x: 1000, y: 800 }, { x: 2000, y: 1200 }]]);
    expect(h.gathers()).toBe(2);
    expect(h.requests).toHaveLength(1);
    expect([...h.disk]).toEqual([]); // the read-ahead's folder went too
  });

  it('changes nothing on screen while it reads ahead', async () => {
    const h = harness({ steps: [hangs({ accept: true })], recordActions: true });
    h.ctl.ask([spot('danger')]);
    await flush();
    const seen = h.log.length;
    const cancels = h.runnerCancels();
    h.ctl.prepare([spot('missing', 2000, 1200)]);
    await flush();
    const quiet = new Set(['capture', 'framed', 'overlaysExcluded', 'windowsExcluded']);
    expect(h.log.slice(seen).filter((e) => !quiet.has(e[0]))).toEqual([]);
    expect(h.of('capture')).toHaveLength(2);
    expect(h.tickets).toHaveLength(1);
    expect(h.states).toEqual([true]);
    expect(h.runnerCancels()).toBe(cancels);
    expect(h.signals[0].aborted).toBe(false);
    expect(h.ctl.running).toBe(true);
  });

  it('removes the folder of a read-ahead that is dropped or replaced', async () => {
    const h = harness();
    h.ctl.prepare([spot('danger')]);
    await flush();
    expect(h.dirs).toHaveLength(1);
    expect(h.disk.has(h.dirs[0])).toBe(true);
    h.ctl.prepare([spot('danger'), spot('missing', 2000, 1200)]);
    await flush();
    expect(h.dirs).toHaveLength(2);
    expect([...h.disk]).toEqual([h.dirs[1]]);
    h.ctl.dropPrepared();
    await flush();
    expect([...h.disk]).toEqual([]);

    // Dropped while its capture runs: lolPing's windows come back into captures, and the folder goes.
    const hung = harness({ captureHangs: true });
    hung.ctl.prepare([spot('danger')]);
    await flush();
    expect(hung.of('overlaysExcluded')).toEqual([true]);
    hung.ctl.dropPrepared();
    await flush();
    expect(hung.of('overlaysExcluded')).toEqual([true, false]);
    expect(hung.of('windowsExcluded')).toEqual([true, false]);
    expect([...hung.disk]).toEqual([]);
  });

  it('fails an adopted ask whose read failed', async () => {
    const h = harness({ captureThrows: true });
    h.ctl.prepare([spot('danger')]);
    await flush();
    expect(h.bubbles()).toEqual([]);
    h.ctl.ask([spot('danger')]);
    await flush();
    expect(h.of('capture')).toHaveLength(1);
    expect(h.adapters).toEqual([]);
    expect(h.bubbles().map((b) => b.line)).toEqual([t.ask.failed.capture]);
    expect(h.ctl.running).toBe(false);
  });
});

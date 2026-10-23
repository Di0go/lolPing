import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { strings, type Lang } from '../../shared/i18n';
import type { PingTag } from '../../shared/ipc';
import type { Settings } from '../../shared/settings';
import { AskMachine, type AskFailure, type Spot } from '../../shared/teammate/askMachine';
import type { SystemTextLayer } from '../../shared/teammate/contextProtocol';
import { overviewToPhysical, physicalToOverview, receiptPoint, type Rect, type Shot } from '../../shared/teammate/coords';
import type { FormField } from '../../shared/teammate/doRules';
import { frameAsk, type Framing } from '../../shared/teammate/framing';
import type { ThreadRecord } from '../../shared/teammate/history';
import { intentFor } from '../../shared/teammate/intents';
import { bubbleMs, lineFromMarkdown, splitLine } from '../../shared/teammate/line';
import { resolveTarget, type Mark } from '../../shared/teammate/marks';
import { needsKey } from '../../shared/teammate/providers';
import type { BuiltinProfile, TeammateSettings } from '../../shared/teammate/settings';
import { threadAction } from '../../shared/teammate/threads';
import {
  applyLimits, parseToolCall, toolDefs, type ActionCall, type Target, type ToolCall,
} from '../../shared/teammate/tools';
import type { BubbleState, CardState, MateAction, MateView, PutState } from '../../shared/teammateIpc';
import type { OverlayManager } from '../overlayManager';
import type { ActionRunner, RunInfo } from './actions';
import { ContextError, type Capture, type ContextClient } from './contextClient';
import type { Doc } from './files';
import { FILE_READ_LIMIT, gather, readFileTool, type GatherDeps, type UsedItem } from './gather';
import type { HistoryStore } from './historyStore';
import type { MateWindows } from './mateWindows';
import { aimsExactly, canLook, firstTurn, systemPrompt, type AskContext } from './prompt';
import {
  ProviderError, type Part, type ProviderAdapter, type RawCall, type StreamHandlers, type Turn,
} from './providers/types';
import type { SecretStore } from './secrets';

type Point = { x: number; y: number };
type Timer = ReturnType<typeof setTimeout>;

export interface AskDeps {
  settings: () => Settings;
  lang: () => Lang;
  secrets: Pick<SecretStore, 'key' | 'instructions' | 'available'>;
  context: Pick<ContextClient, 'capture' | 'foreground' | 'read'>;
  /** What gather reads the marks file and the file behind the window with. */
  readers: Omit<GatherDeps, 'context'>;
  adapter: (p: BuiltinProfile, key: string) => ProviderAdapter;
  overlay: Pick<OverlayManager,
    'spawnMate' | 'spawnMateEmote' | 'mateSaid' | 'clearMate' | 'fadeMate' | 'setMateTicket' | 'setCaptureExcluded'
    | 'displayAt' | 'toLocal' | 'toDip' | 'primaryDip'>;
  windows: Pick<MateWindows,
    'showBubble' | 'updateBubble' | 'hideBubble' | 'hideNow' | 'showCard' | 'updateCard' | 'hideCard'
    | 'setCaptureExcluded'>;
  history: Pick<HistoryStore, 'append' | 'current' | 'amend'>;
  /** The folder each ask's own capture folder goes in. */
  tempDir: () => string;
  /** A 512 px JPEG of a capture as base64, kept with the thread in history. */
  thumbnail: (jpeg: Buffer) => string;
  now: () => number;
  usage: (u: { input: number; output: number }) => void;
  /** Carries out the copy, event, paste, fill and open calls; without it they are dropped. */
  actions?: Pick<ActionRunner, 'take' | 'cancel' | 'described' | 'put'> & Pick<EventEmitter, 'on'>;
  /** The cursor in physical px: a reply in a thread opened from History asks there (no cursor: it does nothing). */
  cursor?: () => Point;
  /** Makes, reads and deletes an ask's capture folder; the file system by default. */
  files?: {
    read(path: string): Promise<Buffer>;
    makeDir(path: string): Promise<void>;
    removeDir(path: string): Promise<void>;
  };
}

/** Spec §7.1, §9.5: tool rounds per answer, the gap between a set of pings, and "the same spot". */
const MAX_ROUNDS = 6;
const PING_GAP_MS = 600;
/** The teammate's pings and emotes stay at least this long after its answer, and while its bubble or card is up. */
const MARKS_MIN_MS = 15_000;
const NEAR_PX = 40;
const RECEIVE_MS = 10_000;
const TOTAL_MS = 60_000;
const TITLE_MAX = 60;
/** The bubble sits up and to the right of the receipt, in DIPs. */
const BUBBLE_OFFSET = { x: 24, y: -24 };

const DONE: Part[] = [{ text: 'Done.' }];
const NOT_AVAILABLE: Part[] = [{ text: 'Not available.' }];
const INVALID: Part[] = [{ text: 'Ignored: the arguments were not valid.' }];
const OVER_LIMIT: Part[] = [{
  text: 'Ignored: an answer has at most 6 pings, 1 emote, 1 paste, 1 fill, 1 event and 3 opens.',
}];
const ANSWER_NUDGE = 'Every ask ends with `say` (the one-line answer) and `answer` (the full answer in Markdown). '
  + 'Call both in the same round as your pings.';

interface Run {
  machine: AskMachine;
  abort: AbortController;
  deadlines: Timer[];
  ended: boolean;
  spot: Spot;
  receipt: Point;
  display: { id: number; rect: Rect } | null;
  intent: ReturnType<typeof intentFor>;
  words: string | null;
  thread: ThreadRecord | null;
  /** The card opens by itself: Whole picture, Translate, or Push on the spot just answered. */
  autoCard: boolean;
  lang: Lang;
  tag: PingTag;
  emotes: boolean;
  profile: BuiltinProfile | null;
  shot: Shot | null;
  app: string;
  title: string;
  /** The window the ask was made in (an HWND in decimal on Windows), for pasting and filling into it later. */
  window: string;
  thumb: string;
  text: string;
  /** The bubble's line; the first `say` in full, which the card and history keep; what the line cut off. */
  line: string;
  said: string;
  rest: string;
  /** Answers and later says, for the card. */
  markdown: string[];
  tokens: number | null;
  calls: ToolCall[];
  /** Says shown while their turn was still streaming: when the turn ends, play() skips each of them once. */
  early: string[];
  pings: number;
  /** Where its pings and emotes went (physical px): asking on one of them continues the thread. */
  marks: Point[];
  /** This ask's capture folder, removed when the ask ends however it ends. */
  dir: string;
  /** Controls and text lines near the spot, which the teammate's pings snap onto. */
  screenMarks: Mark[];
  /** The whole file behind the window, which read_file serves. */
  doc: Doc | null;
  used: UsedItem[];
  skipped: boolean;
  /** File characters `read_file` has given this ask. */
  fileRead: number;
  /** What the context read at the ask: the focused field and selection, the form fields, the element under the spot. */
  system: SystemTextLayer | null;
  fields: FormField[];
  box: Rect | null;
  /** What the action runner is given with each call of this ask; made at the first one. */
  info: RunInfo | null;
}

const isAction = (c: ToolCall): c is ActionCall => (
  c.tool === 'copy' || c.tool === 'event' || c.tool === 'paste' || c.tool === 'fill' || c.tool === 'open'
);

/** One ask and its answer as the card shows them. */
const entryPair = (
  label: string, words: string | null, line: string, markdown: string, tagName: string,
): CardState['entries'] => [
  { kind: 'ask', label, markdown: words ?? '' },
  { kind: 'answer', label: tagName, line, markdown },
];

/** One thing the answer used, as the card footer names it. */
function usedLabel(u: UsedItem, lang: Lang): string {
  const t = strings(lang).teammate.ask;
  switch (u.kind) {
    case 'selection': return t.usedSelection;
    case 'text': return t.usedText;
    case 'marks': return t.usedMarks;
    case 'address': return t.usedAddress;
    case 'file': return t.usedFile(u.name, u.unit, u.from, u.to);
  }
}

const near = (p: Point, list: readonly Point[]): boolean =>
  list.some((q) => Math.hypot(p.x - q.x, p.y - q.y) <= NEAR_PX);

function failureOf(err: unknown): AskFailure {
  if (err instanceof ProviderError) return err.kind;
  if (err instanceof ContextError) return 'capture';
  return 'other';
}

/** `deep` intents go to the deep profile when one is set, everything else to the default one. */
function route(t: TeammateSettings, deep: boolean): BuiltinProfile | null {
  const id = deep && t.deepProfile ? t.deepProfile : t.defaultProfile;
  return t.profiles.find((p) => p.id === id) ?? null;
}

/**
 * Turns an ask into an answer on screen: capture, model turns, then the receipt, the line, the teammate's pings and
 * emotes, the card and the history entry. One ask at a time; anything from an ask that was replaced or cancelled is
 * dropped. Emits 'state' (running: boolean) when an ask starts or ends.
 */
export class AskController extends EventEmitter {
  private run: Run | null = null;
  /** The run whose answer is on screen, running or not: the bubble's and card's actions act on it. */
  private shown: Run | null = null;
  private readonly files: NonNullable<AskDeps['files']>;
  private marksShown = false;
  private bubbleShown = false;
  private cardShown = false;
  private bubbleTimer: Timer | null = null;
  private bubbleEndsAt = 0;
  private fadeTimer: Timer | null = null;
  private readonly pingTimers = new Set<Timer>();
  private nextPingAt = 0;
  /** When the answer on screen finished or failed; its marks stay MARKS_MIN_MS from then. Null while it is coming. */
  private answeredAt: number | null = null;
  private excluded = 0;
  /** The thread asks continue: kept here so it works with history off or paused, and across a pause. */
  private thread: ThreadRecord | null = null;
  /** A thread opened from History that the card shows; its reply box continues it. */
  private viewed: ThreadRecord | null = null;
  /** The last answer's history entry: an action done after it was written (after consent) is added to it. */
  private entry: { ask: string; at: number; thread: Promise<string | null> } | null = null;
  /** The runner's put button for the answer on screen: the bubble and the card show it. */
  private put: PutState = null;
  /**
   * The run whose bubble or card the runner hid for a paste. Only that one comes back (as the bubble) when the paste
   * doesn't land; one the user closed, or whose time ran out, stays closed.
   */
  private hiddenForPut: Run | null = null;

  constructor(private readonly deps: AskDeps) {
    super();
    this.files = deps.files ?? {
      read: (p) => readFile(p),
      makeDir: async (p) => {
        await mkdir(p, { recursive: true });
      },
      removeDir: (p) => rm(p, { recursive: true, force: true }),
    };
    deps.actions?.on('described', (ask: string, done: string[]) => this.amendDone(ask, done));
    deps.actions?.on('put', (state: PutState) => this.showPut(state));
  }

  get running(): boolean {
    return this.run !== null;
  }

  ask(spot: Spot, words?: { text: string; newThread: boolean }): void {
    const prev = this.shown;
    const settings = this.deps.settings();
    const t = settings.teammate;
    const lang = this.deps.lang();
    const intent = intentFor(t, spot.intent, lang);
    const machine = new AskMachine(this.deps.now, { receiveMs: RECEIVE_MS, totalMs: TOTAL_MS });
    machine.addSpot(spot);

    this.stopRun();
    this.deps.actions?.cancel(); // a consent card or form preview of the last answer goes, and nothing of it runs
    this.answeredAt = null;
    this.clearMarks();
    this.hideBubble();
    this.clearTimer('fade');
    this.viewed = null;
    this.deps.overlay.setMateTicket(machine.id);

    const current = this.currentThread();
    const onTeammate = prev !== null && near(spot.phys, prev.marks);
    const thread = threadAction(spot.intent, current, { onTeammate, newThread: words?.newThread }) === 'continue'
      ? current : null;
    if (!thread) this.hideCard();
    const samePush = spot.intent === 'push' && prev !== null && near(spot.phys, [prev.spot.phys]);
    const display = this.deps.overlay.displayAt(spot.phys);

    const run: Run = {
      machine, abort: new AbortController(), deadlines: [], ended: false, spot, display,
      receipt: display ? receiptPoint(spot.phys, display.rect) : spot.phys,
      intent, words: words?.text ?? null, thread, autoCard: intent.def.autoCard || samePush, lang,
      tag: { name: t.tagName, color: t.tagColor, rgb: t.tagColorCustom }, emotes: t.emotes,
      profile: null, shot: null, app: '', title: '', window: '', thumb: '', text: '', line: '', said: '', rest: '',
      markdown: [], tokens: null,
      calls: [], early: [], pings: 0, marks: [], dir: join(this.deps.tempDir(), machine.id),
      screenMarks: [], doc: null, used: [], skipped: false, fileRead: 0,
      system: null, fields: [], box: null, info: null,
    };
    this.run = run;
    this.shown = run;
    this.nextPingAt = 0;
    this.bubbleEndsAt = 0;
    this.emit('state', true);
    if (this.cardShown) this.deps.windows.updateCard(this.cardState(run, true));
    this.go(run).catch((err: unknown) => console.warn('[teammate] ask failed:', err));
  }

  /** The thread the next ask continues: the last answer's, or one History made current. */
  currentThread(): ThreadRecord | null {
    return this.thread ?? this.deps.history.current();
  }

  /** History dropped a thread (`id`), or every thread (no id): asks no longer continue it. */
  forgetThread(id?: string): void {
    if (id === undefined || this.thread?.id === id) this.thread = null;
    if (id === undefined || this.viewed?.id === id) this.viewed = null;
  }

  /** History's Continue: the next push, reply or words go into this thread. */
  continueThread(record: ThreadRecord): void {
    this.thread = record;
  }

  /** History's Open: the thread as a card at `at` (DIPs), in place of what the teammate had on screen. */
  showThread(record: ThreadRecord, at: Point): void {
    this.cancel('user');
    const t = this.deps.settings().teammate;
    const lang = this.deps.lang();
    this.deps.windows.showCard(at, {
      view: 'card', lang, tag: { name: t.tagName, color: t.tagColor, rgb: t.tagColorCustom }, title: record.title,
      entries: this.threadEntries(record, lang, t.tagName), streaming: false,
      footer: { profile: record.profile, model: '', tokens: null, used: [] }, put: null,
    });
    this.cardShown = true;
    this.viewed = record;
  }

  /** What the bubble and card ask for; the rest (copy, link, history) is the app's to handle. */
  onTeammateAction(view: MateView, a: MateAction): void {
    const run = this.shown;
    if (!run && this.viewed && view === 'card' && (a.t === 'reply' || a.t === 'deep')) return this.askFromViewed(a);
    switch (a.t) {
      case 'more':
        if (view === 'bubble' && run) this.openCard(run);
        break;
      case 'dismiss':
        this.hideBubble();
        break;
      case 'close':
        this.hideCard();
        this.viewed = null;
        break;
      case 'reply':
        if (run) this.ask({ ...run.spot, intent: 'generic' }, { text: a.text, newThread: false });
        break;
      case 'deep':
        if (run) this.ask({ ...run.spot, intent: 'allin' });
        break;
      case 'put':
        // The click is the consent; the runner checks it belongs to the action it has for this ask.
        if (run?.info && (view === 'bubble' || view === 'card')) void this.deps.actions?.put(run.info, view);
        break;
      default:
        break;
    }
  }

  /**
   * The runner hides the bubble before a click paste, so nothing of lolPing's is over the point it clicks. At once:
   * the helper checks the point as soon as the paste starts, and a bubble still fading out would be found there.
   */
  hideBubbleForPut(): void {
    if (!this.bubbleShown) return this.deps.windows.hideNow('bubble'); // one still fading out from a hide just before
    this.hideBubble(true);
    this.hiddenForPut = this.shown;
  }

  /** The runner closes a card that had focus before a paste, so the keyboard goes back to the app. */
  hideCardForPut(): void {
    if (!this.cardShown) return;
    this.hideCard();
    this.hiddenForPut = this.shown;
  }

  /** Stops the running ask, if any, and clears everything the teammate has on screen. */
  cancel(_reason: 'new' | 'pause' | 'helper' | 'user'): void {
    this.stopRun();
    this.deps.actions?.cancel();
    // Unconditionally: whatever the flags say, nothing of the teammate may stay on screen after a pause.
    this.marksShown = true;
    this.clearMarks();
    this.bubbleShown = true;
    this.hideBubble();
    this.cardShown = true;
    this.hideCard();
    this.clearTimer('fade');
    this.answeredAt = null;
    this.shown = null;
    this.viewed = null;
  }

  /** A thread opened from History has no spot of its own: its reply asks at the cursor. */
  private askFromViewed(a: Extract<MateAction, { t: 'reply' | 'deep' }>): void {
    const phys = this.deps.cursor?.();
    const display = phys ? this.deps.overlay.displayAt(phys) : null;
    if (!phys || !display || !this.viewed) return;
    if (a.t === 'deep') return this.ask({ intent: 'allin', phys, displayId: display.id });
    this.thread = this.viewed;
    this.ask({ intent: 'generic', phys, displayId: display.id }, { text: a.text, newThread: false });
  }

  private alive(run: Run): boolean {
    return this.run === run && !run.ended;
  }

  private async go(run: Run): Promise<void> {
    try {
      await this.answer(run);
    } catch (err) {
      if (this.alive(run)) this.fail(run, failureOf(err));
    } finally {
      // Also when the ask was cancelled mid-capture: context-helper may still write into the folder, and fails once
      // it is gone. Whatever slips past that is removed with the whole temp folder when the teammate stops or starts.
      this.files.removeDir(run.dir).catch(() => undefined);
    }
  }

  private async answer(run: Run): Promise<void> {
    const { deps } = this;
    const t = deps.settings().teammate;
    const profile = route(t, run.intent.def.deep);
    const stored = profile && deps.secrets.available() ? deps.secrets.key(profile.id) : null;
    const key = stored ?? (profile && !needsKey(profile) ? '' : null);
    if (!profile || key === null) return this.fail(run, 'noProfile');
    if (!run.display) return this.fail(run, 'capture');
    run.profile = profile;
    run.machine.startGathering();
    // The total time runs from here, so a capture, helper or file read that hangs can't hold the ask up.
    this.deadline(run, TOTAL_MS, () => this.fail(run, 'timeout'));
    const signal = run.abort.signal;

    const fg = await deps.context.foreground(signal).catch(() => ({ app: '', title: '', window: '' }));
    if (!this.alive(run)) return;
    run.app = fg.app;
    run.title = fg.title;
    run.window = fg.window;
    // The context comes first: the boxes around the spot decide what the capture shows.
    await this.files.makeDir(run.dir);
    const allin = run.intent.def.id === 'allin';
    const layers = await gather({ context: deps.context, ...deps.readers }, {
      settings: t.context, spots: [run.spot.phys], dir: run.dir, allin, title: run.title,
      act: run.intent.def.kind === 'act',
    }, signal);
    if (!this.alive(run)) return;
    const framing = frameAsk(run.intent.def.id, layers.boxes[0] ?? [], run.display.rect, run.spot.phys);
    const cap = await this.capture(run, [run.spot.phys], framing);
    if (!this.alive(run)) return;
    const shot: Shot = { area: framing.area, overview: cap.overview, zooms: cap.zooms.map((z) => z.rect) };
    run.shot = shot;
    const overviewJpeg = await this.files.read(cap.overviewPath);
    const zoomJpegs = await Promise.all(cap.zooms.map((z) => this.files.read(z.path)));
    if (!this.alive(run)) return;
    run.thumb = deps.thumbnail(zoomJpegs[0] ?? overviewJpeg);
    run.screenMarks = layers.marks;
    run.system = layers.system;
    run.fields = layers.fields;
    run.box = layers.boxes[0]?.[0] ?? null;
    run.doc = layers.doc;
    // Marks are read for every ask so pings snap, but only the asks whose prompt lists them used them.
    run.used = aimsExactly(run.intent.def.id) ? layers.used : layers.used.filter((u) => u.kind !== 'marks');
    run.skipped = layers.skipped;
    const ctx: AskContext = {
      lang: run.lang, intent: run.intent, words: run.words, app: run.app, title: run.title,
      shot, spots: [physicalToOverview(shot, run.spot.phys)], overviewJpeg, zoomJpegs, thread: run.thread,
      instructions: deps.secrets.instructions(), emotes: run.emotes, marks: layers.marks, system: layers.system,
      file: layers.file, fields: layers.fields,
    };
    const adapter = deps.adapter(profile, key);
    const system = systemPrompt(ctx);
    // The same `file` and intent decide the tools and the prompt's rules for them, so the two never disagree.
    let tools = toolDefs({
      emotes: run.emotes, spots: 1, file: ctx.file !== null, look: canLook(run.intent.def.id),
      kind: run.intent.def.kind, form: (ctx.fields?.length ?? 0) > 0,
    });
    const turns: Turn[] = [firstTurn(ctx)];
    run.machine.sent();
    this.deadline(run, RECEIVE_MS, () => {
      if (run.machine.phase === 'sent') this.fail(run, 'notReceived');
    });

    let nudged = false;
    for (let round = 0; round < MAX_ROUNDS; round += 1) {
      const result = await adapter.turn({ system, turns, tools, model: profile.model }, this.handlers(run), signal);
      if (!this.alive(run)) return;
      this.received(run); // a provider that streams nothing before its answer still gets a receipt
      run.machine.answering();
      run.text += result.text;
      turns.push({ role: 'assistant', text: result.text, calls: result.calls });
      const last = round === MAX_ROUNDS - 1;
      const step = await this.play(run, result.calls, new Set(tools.map((d) => d.name)), last);
      if (!this.alive(run)) return;
      // One look round per ask: each costs a whole round trip.
      if (result.calls.some((c) => c.name === 'look')) tools = tools.filter((d) => d.name !== 'look');
      // Pings alone leave nothing to read. A round that goes on anyway carries the reminder for free; a round that
      // would end the ask is followed by one more, once.
      const unanswered = !run.line && run.markdown.length === 0 && !run.text.trim();
      if (!step.again && (!unanswered || nudged || last)) break;
      if (!step.again) nudged = true;
      if (result.calls.length === 0) {
        turns.push({ role: 'user', parts: [{ text: ANSWER_NUDGE }] });
        continue;
      }
      const lastResult = step.results[step.results.length - 1];
      if (unanswered && lastResult) lastResult.content = [...lastResult.content, { text: ANSWER_NUDGE }];
      turns.push({ role: 'tool', results: step.results });
    }
    await this.finish(run);
  }

  private handlers(run: Run): StreamHandlers {
    return {
      accepted: () => {
        if (this.alive(run)) this.received(run);
      },
      text: () => undefined,
      // The line goes up as soon as its call is complete, not after the whole card answer behind it.
      call: (raw) => {
        if (raw.name !== 'say' || !this.alive(run)) return;
        const c = parseToolCall(raw.name, raw.args);
        if (c?.tool !== 'say') return;
        this.received(run);
        run.early.push(c.text);
        this.say(run, c.text);
      },
      usage: (u) => {
        // Tokens are spent even when the ask was cancelled, so they always count.
        this.deps.usage(u);
        run.tokens = (run.tokens ?? 0) + u.input + u.output;
      },
    };
  }

  /**
   * A deadline fails the ask with its own reason when it fires, unless the ask is over. Timers run on libuv's cached
   * loop time, which can be a few ms behind now(), so re-checking the clock here (machine.tick) could find the
   * deadline not yet due and never fire.
   */
  private deadline(run: Run, ms: number, onDue: () => void): void {
    run.deadlines.push(this.timer(ms, () => {
      if (this.alive(run)) onDue();
    }));
  }

  /** A timer whose callback can't throw into the main process. */
  private timer(ms: number, fn: () => void): Timer {
    return setTimeout(() => {
      try {
        fn();
      } catch (err) {
        console.warn('[teammate]', err);
      }
    }, ms);
  }

  private exclude(on: boolean): void {
    for (const target of [this.deps.overlay, this.deps.windows]) {
      try {
        target.setCaptureExcluded(on);
      } catch (err) {
        console.warn('[teammate] capture exclusion:', err);
      }
    }
  }

  /**
   * Overlays and teammate windows stay out of the grab; a count, so an older ask's capture can't let them back in.
   * Without a framing the overview is the whole display and each close-up a fixed crop around its spot.
   */
  private async capture(run: Run, spots: Point[], framing?: Framing): Promise<Capture> {
    const rect = run.display?.rect;
    if (!rect) throw new ContextError('capture', 'no display under the spot');
    try {
      this.excluded += 1;
      if (this.excluded === 1) this.exclude(true);
      await this.files.makeDir(run.dir);
      const framed = framing ? { area: framing.area, crops: [framing.crop] } : {};
      return await this.deps.context.capture({ display: rect, spots, dir: run.dir, ...framed }, run.abort.signal);
    } finally {
      this.excluded -= 1;
      if (this.excluded === 0) this.exclude(false);
    }
  }

  /** The teammate's On My Way next to the user's ping, kept until the answer is over. */
  private received(run: Run): void {
    if (!run.machine.received()) return;
    const at = this.deps.overlay.toLocal(run.receipt);
    if (!at) return;
    const t = this.deps.settings().teammate;
    // For a Do it ask the user's own ping is already On My Way: the receipt is the tag with its dots alone.
    const tagOnly = run.spot.intent === 'omw' ? { tagOnly: true } : {};
    this.deps.overlay.spawnMate({
      ...at, id: 'omw', thinking: true, keep: true, silent: !t.receiptSound, tag: run.tag, ...tagOnly,
    });
    this.marksShown = true;
  }

  /** Draws one round of tool calls and says what each one did, for the model's next round. */
  private async play(
    run: Run,
    raws: RawCall[],
    offered: ReadonlySet<string>,
    lastRound: boolean,
  ): Promise<{ again: boolean; results: { id: string; content: Part[] }[] }> {
    const parsed = raws.map((raw) => ({ raw, call: parseToolCall(raw.name, raw.args) }));
    for (const p of parsed) if (p.call) run.calls.push(p.call);
    const kept = new Set(applyLimits(run.calls));
    const results = new Map<RawCall, Part[]>();
    const valid: { raw: RawCall; call: ToolCall }[] = [];
    let again = false;
    for (const { raw, call } of parsed) {
      if (!offered.has(raw.name)) {
        results.set(raw, NOT_AVAILABLE);
        again = true;
      } else if (!call) {
        results.set(raw, INVALID);
      } else if (!kept.has(call)) {
        results.set(raw, OVER_LIMIT);
      } else {
        results.set(raw, DONE);
        valid.push({ raw, call });
      }
    }

    // The line comes first whatever order the model used, then the card, then the marks.
    for (const { call } of valid) {
      if (call.tool !== 'say') continue;
      const shown = run.early.indexOf(call.text);
      if (shown >= 0) run.early.splice(shown, 1);
      else this.say(run, call.text);
    }
    for (const { call } of valid) if (call.tool === 'answer') this.addAnswer(run, call.markdown);
    const pings = valid.flatMap(({ call }) => (call.tool === 'ping' ? [call] : []));
    pings.sort((a, b) => (a.order ?? Infinity) - (b.order ?? Infinity));
    for (const p of pings) this.placePing(run, p);
    for (const { call } of valid) if (call.tool === 'emote') this.placeEmote(run, call);
    for (const { call } of valid) if (isAction(call)) this.takeAction(run, call);
    for (const { raw, call } of valid) {
      if (call.tool !== 'read_file') continue;
      // Like look: no round follows the last one to read what it gives.
      if (lastRound || !run.doc) {
        results.set(raw, NOT_AVAILABLE);
        continue;
      }
      again = true;
      const read = readFileTool(run.doc, call, run.fileRead, FILE_READ_LIMIT);
      run.fileRead = read.served;
      results.set(raw, [{ text: read.text }]);
    }
    for (const { raw, call } of valid) {
      if (call.tool !== 'look') continue;
      // No round follows the last one to read a look, so don't capture for it.
      if (lastRound) {
        results.set(raw, NOT_AVAILABLE);
        continue;
      }
      again = true;
      results.set(raw, await this.look(run, call));
      if (!this.alive(run)) break;
    }
    return { again, results: raws.map((raw) => ({ id: raw.id, content: results.get(raw) ?? DONE })) };
  }

  private takeAction(run: Run, call: ActionCall): void {
    this.deps.actions?.take(this.runInfo(run), call);
  }

  private runInfo(run: Run): RunInfo {
    const focus = run.system?.focus ?? null;
    run.info ??= {
      id: run.machine.id, profileId: run.profile?.id ?? '', tag: run.tag, app: run.app, window: run.window,
      lang: run.lang, spot: run.spot.phys, at: this.deps.overlay.toDip(run.spot.phys) ?? this.deps.overlay.primaryDip(),
      box: run.box, focus: focus ? { kind: focus.kind, label: focus.label, secure: focus.secure } : null,
      selection: run.system?.selection ?? '', fields: run.fields,
    };
    return run.info;
  }

  private async look(run: Run, area: { x: number; y: number; w: number; h: number }): Promise<Part[]> {
    const centre = run.shot ? overviewToPhysical(run.shot, { x: area.x + area.w / 2, y: area.y + area.h / 2 }) : null;
    if (!centre) return [{ text: 'That area is outside the screen.' }];
    try {
      const cap = await this.capture(run, [centre]);
      const zoom = cap.zooms[0];
      if (!zoom) return [{ text: 'Could not look closer.' }];
      const data = await this.files.read(zoom.path);
      const cx = Math.round(area.x + area.w / 2);
      const cy = Math.round(area.y + area.h / 2);
      return [
        { text: `A full-resolution view around x=${cx}, y=${cy} of the overview.` },
        { image: { mime: 'image/jpeg', data } },
      ];
    } catch {
      return [{ text: 'Could not look closer.' }];
    }
  }

  private target(run: Run, at: Target): Point | null {
    // The model numbers the user's spots from 1; a pixel point snaps onto the control or text line under it.
    return run.shot ? resolveTarget(at, { spots: [run.spot.phys], marks: run.screenMarks, shot: run.shot }) : null;
  }

  private placePing(run: Run, c: Extract<ToolCall, { tool: 'ping' }>): void {
    const point = this.target(run, c.at);
    const at = point ? this.deps.overlay.toLocal(point) : null;
    if (!point || !at) return;
    run.marks.push(point);
    const ping = {
      ...at, id: c.type, keep: true, tag: run.tag,
      ...(c.label ? { label: c.label } : {}),
      ...(run.pings > 0 ? { silent: true } : {}), // one sound for the whole set
    };
    run.pings += 1;
    const now = this.deps.now();
    const when = Math.max(now, this.nextPingAt);
    this.nextPingAt = when + PING_GAP_MS;
    const show = () => {
      this.deps.overlay.spawnMate(ping);
      this.marksShown = true;
    };
    if (when <= now) {
      show();
      return;
    }
    const timer = this.timer(when - now, () => {
      this.pingTimers.delete(timer);
      show();
    });
    this.pingTimers.add(timer);
  }

  private placeEmote(run: Run, c: Extract<ToolCall, { tool: 'emote' }>): void {
    const point = this.target(run, c.at);
    const at = point ? this.deps.overlay.toLocal(point) : null;
    if (!point || !at) return;
    run.marks.push(point);
    this.deps.overlay.spawnMateEmote({ ...at, slug: c.slug, keep: true, tag: run.tag });
    this.marksShown = true;
  }

  private say(run: Run, text: string): void {
    if (run.line) {
      run.markdown.push(text);
      this.refresh(run);
      return;
    }
    const { line, rest } = splitLine(text, run.lang);
    run.line = line;
    run.rest = rest;
    run.said = rest ? text.trim() : line;
    this.deps.overlay.mateSaid();
    if (this.cardShown) this.deps.windows.updateCard(this.cardState(run, true));
    else this.showLine(run, line);
  }

  private addAnswer(run: Run, markdown: string): void {
    run.markdown.push(markdown);
    if (run.autoCard && !this.cardShown) this.openCard(run);
    else this.refresh(run);
  }

  /** The card, or the bubble's More button, catches up with what the answer has so far. */
  private refresh(run: Run): void {
    if (this.cardShown) this.deps.windows.updateCard(this.cardState(run, this.alive(run)));
    else if (this.bubbleShown) this.deps.windows.updateBubble(this.bubbleState(run, run.line));
  }

  private async finish(run: Run): Promise<void> {
    if (!run.line && run.text.trim()) this.say(run, run.text);
    // A model that skipped `say` is not asked again, which would cost a whole round: the card's start is the line.
    // The card keeps no copy of it above the answer it came from.
    if (!run.line && run.markdown.length > 0) {
      run.line = lineFromMarkdown(run.markdown.join('\n\n'), run.lang);
      if (run.line) {
        this.deps.overlay.mateSaid();
        if (!run.autoCard && !this.cardShown) this.showLine(run, run.line);
      }
    }
    if (!run.line && run.markdown.length === 0 && run.marks.length === 0) return this.fail(run, 'other');
    if (!run.line) {
      this.deps.overlay.mateSaid(); // the thinking is over even without a line
      // Only an answer for the card: the bubble shows just its More button.
      if (run.markdown.length > 0 && !run.autoCard && !this.cardShown) this.showLine(run, '');
    }
    run.machine.done();
    this.stopRun();
    // A line whose time ran out while the answer was still coming gets its time again from now.
    if (this.bubbleShown && this.bubbleTimer === null) this.armBubble(run, run.line);
    if (run.autoCard && !this.cardShown) this.openCard(run);
    else if (this.cardShown) this.deps.windows.updateCard(this.cardState(run, false));
    this.answeredAt = this.deps.now();
    this.scheduleFade();
    // What the actions did, never what they put anywhere (spec §8.2).
    const done = this.deps.actions?.described() ?? [];
    const entry = {
      at: this.deps.now(), intent: run.spot.intent, words: run.words, line: run.said,
      markdown: run.markdown.join('\n\n'), thumb: run.thumb, ...(done.length > 0 ? { done } : {}),
    };
    const meta = {
      title: (run.line || run.intent.label).slice(0, TITLE_MAX), app: run.app, windowTitle: run.title,
      profile: run.profile?.name ?? '',
    };
    // The thread is kept here first, so it continues even when history is off and append saves nothing.
    const now = this.deps.now();
    const local: ThreadRecord = run.thread
      ? { ...run.thread, lastActivity: now, entries: [...run.thread.entries, entry] }
      : { id: randomUUID(), ...meta, started: now, lastActivity: now, entries: [entry] };
    this.thread = local;
    const saving = this.deps.history.append(run.thread?.id ?? null, entry, meta).catch(() => null);
    this.entry = { ask: run.machine.id, at: entry.at, thread: saving.then((s) => s?.id ?? null) };
    const saved = await saving;
    // A saved record replaces ours only when it is the same thread: with history off, append makes a new one each time.
    if (saved && this.thread === local && (run.thread === null || saved.id === run.thread.id)) this.thread = saved;
  }

  /**
   * The put button changed, or a paste didn't land and the button stays. The card or the bubble shows it; when neither
   * is up because the runner hid it for the paste, the bubble comes back with it.
   */
  private showPut(state: PutState): void {
    this.put = state;
    const run = this.shown;
    if (!run) return;
    if (this.cardShown) {
      this.deps.windows.updateCard(this.cardState(run, this.alive(run)));
    } else if (this.bubbleShown) {
      this.deps.windows.updateBubble(this.bubbleState(run, run.line));
      // A button that just came deserves the line's whole reading time, not what was left of it.
      if (state !== null) this.armBubble(run, run.line);
    } else if (state !== null && this.hiddenForPut === run) {
      this.showLine(run, run.line);
    }
  }

  /** An action of the last answer was done after its entry went into history: the entry says so too. */
  private amendDone(ask: string, done: string[]): void {
    const entry = this.entry;
    if (entry?.ask !== ask) return; // still answering: finish() takes it from described()
    entry.thread
      .then((id) => (id === null ? undefined : this.deps.history.amend(id, entry.at, done)))
      .catch((err: unknown) => console.warn('[teammate] history:', err));
  }

  private fail(run: Run, reason: AskFailure): void {
    run.machine.fail(reason);
    this.stopRun();
    this.clearMarks();
    const at = this.deps.overlay.toLocal(run.receipt);
    if (at) {
      this.deps.overlay.spawnMate({ ...at, id: 'missing', keep: true, tag: run.tag });
      this.marksShown = true;
    }
    if (this.cardShown) this.deps.windows.updateCard(this.cardState(run, false));
    this.showLine(run, strings(run.lang).teammate.ask.failed[reason]);
    this.answeredAt = this.deps.now();
    this.scheduleFade();
  }

  /** Ends the running ask, if any: its requests are aborted and its deadlines dropped. */
  private stopRun(): void {
    const run = this.run;
    if (!run) return;
    run.ended = true;
    run.machine.cancel(); // no-op once the ask is done or failed
    run.abort.abort();
    for (const d of run.deadlines) clearTimeout(d);
    this.run = null;
    this.emit('state', false);
  }

  private showLine(run: Run, line: string): void {
    this.hiddenForPut = null;
    const state = this.bubbleState(run, line);
    if (this.bubbleShown) this.deps.windows.updateBubble(state);
    else this.deps.windows.showBubble(this.popupAt(run), state);
    this.bubbleShown = true;
    this.armBubble(run, line);
  }

  /** The line's time on screen. While its answer is still coming the line stays, and finish() starts its time again. */
  private armBubble(run: Run, line: string): void {
    this.clearTimer('bubble');
    const ms = bubbleMs(line);
    this.bubbleEndsAt = this.deps.now() + ms;
    this.bubbleTimer = this.timer(ms, () => {
      this.bubbleTimer = null;
      if (!this.alive(run)) this.hideBubble();
    });
  }

  private bubbleState(run: Run, line: string): BubbleState {
    return {
      view: 'bubble', lang: run.lang, tag: run.tag, line, thread: run.thread?.title ?? null, thinking: false,
      // An answer's line always offers More, if only for the card's reply box; a failure's line doesn't.
      more: run.rest !== '' || run.markdown.length > 0 || (line !== '' && run.machine.failure === null),
      put: this.put,
    };
  }

  private openCard(run: Run): void {
    // The card grows out of the bubble, which goes.
    this.hideBubble();
    this.deps.windows.showCard(this.popupAt(run), this.cardState(run, this.alive(run)));
    this.cardShown = true;
    this.clearTimer('fade'); // the marks stay while the card is up; closing it schedules their fade
  }

  private cardState(run: Run, streaming: boolean): CardState {
    const t = strings(run.lang).teammate;
    const entries = run.thread ? this.threadEntries(run.thread, run.lang, run.tag.name) : [];
    entries.push(...entryPair(run.intent.label, run.words, run.said, run.markdown.join('\n\n'), run.tag.name));
    return {
      view: 'card', lang: run.lang, tag: run.tag, entries, streaming,
      title: run.thread?.title ?? (run.line || run.intent.label).slice(0, TITLE_MAX),
      footer: {
        profile: run.profile?.name ?? '', model: run.profile?.model ?? '', tokens: run.tokens,
        used: [
          t.ask.usedScreen,
          ...run.used.map((u) => usedLabel(u, run.lang)),
          ...(run.skipped ? [t.ask.contextSkipped] : []),
        ],
      },
      put: this.put,
    };
  }

  private threadEntries(thread: ThreadRecord, lang: Lang, tagName: string): CardState['entries'] {
    const s = this.deps.settings().teammate;
    return thread.entries.flatMap((e) =>
      entryPair(intentFor(s, e.intent, lang).label, e.words, e.line, e.markdown, tagName));
  }

  private popupAt(run: Run): Point {
    const dip = this.deps.overlay.toDip(run.receipt);
    return dip ? { x: dip.x + BUBBLE_OFFSET.x, y: dip.y + BUBBLE_OFFSET.y } : this.deps.overlay.primaryDip();
  }

  /**
   * The teammate's marks fade once the bubble is gone and the card is closed, and never sooner than MARKS_MIN_MS
   * after the answer (nor before the last ping has been drawn). A card that opens or closes later calls this again.
   */
  private scheduleFade(): void {
    this.clearTimer('fade');
    if (this.answeredAt === null || this.cardShown) return;
    const now = this.deps.now();
    const lastPingAt = this.nextPingAt > 0 ? this.nextPingAt - PING_GAP_MS : 0;
    const at = Math.max(this.bubbleEndsAt, this.answeredAt + MARKS_MIN_MS, lastPingAt);
    this.fadeTimer = this.timer(Math.max(0, at - now), () => {
      this.fadeTimer = null;
      this.answeredAt = null;
      if (!this.marksShown) return;
      this.deps.overlay.fadeMate();
      this.marksShown = false;
    });
  }

  private clearMarks(): void {
    for (const timer of this.pingTimers) clearTimeout(timer);
    this.pingTimers.clear();
    if (!this.marksShown) return;
    this.deps.overlay.clearMate();
    this.marksShown = false;
  }

  /** Any hide but the runner's own (a dismiss, the line's time, a new ask, a pause) keeps the bubble from coming back. */
  private hideBubble(now = false): void {
    this.hiddenForPut = null;
    this.clearTimer('bubble');
    this.bubbleEndsAt = 0;
    if (!this.bubbleShown) return;
    if (now) this.deps.windows.hideNow('bubble');
    else this.deps.windows.hideBubble();
    this.bubbleShown = false;
  }

  private hideCard(): void {
    this.hiddenForPut = null;
    if (!this.cardShown) return;
    this.deps.windows.hideCard();
    this.cardShown = false;
    if (this.marksShown) this.scheduleFade();
  }

  private clearTimer(which: 'bubble' | 'fade'): void {
    const timer = which === 'bubble' ? this.bubbleTimer : this.fadeTimer;
    if (timer) clearTimeout(timer);
    if (which === 'bubble') this.bubbleTimer = null;
    else this.fadeTimer = null;
  }
}

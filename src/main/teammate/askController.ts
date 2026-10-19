import { EventEmitter } from 'node:events';
import { readFile, rm } from 'node:fs/promises';
import { strings, type Lang } from '../../shared/i18n';
import type { PingTag } from '../../shared/ipc';
import type { Settings } from '../../shared/settings';
import { AskMachine, type AskFailure, type Spot } from '../../shared/teammate/askMachine';
import { overviewToPhysical, receiptPoint, type Shot } from '../../shared/teammate/coords';
import type { ThreadRecord } from '../../shared/teammate/history';
import { intentFor } from '../../shared/teammate/intents';
import { bubbleMs, splitLine } from '../../shared/teammate/line';
import type { BuiltinProfile, TeammateSettings } from '../../shared/teammate/settings';
import { threadAction } from '../../shared/teammate/threads';
import { applyLimits, parseToolCall, toolDefs, type Target, type ToolCall } from '../../shared/teammate/tools';
import type { BubbleState, CardState, MateAction, MateView } from '../../shared/teammateIpc';
import type { OverlayManager } from '../overlayManager';
import { ContextError, type Capture, type ContextClient } from './contextClient';
import type { HistoryStore } from './historyStore';
import type { MateWindows } from './mateWindows';
import { firstTurn, systemPrompt, type AskContext } from './prompt';
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
  context: Pick<ContextClient, 'capture' | 'foreground'>;
  adapter: (p: BuiltinProfile, key: string) => ProviderAdapter;
  overlay: Pick<OverlayManager,
    'spawnMate' | 'spawnMateEmote' | 'mateSaid' | 'clearMate' | 'fadeMate' | 'setMateTicket' | 'setCaptureExcluded'
    | 'displayAt' | 'toLocal' | 'toDip'>;
  windows: Pick<MateWindows,
    'showBubble' | 'updateBubble' | 'hideBubble' | 'showCard' | 'updateCard' | 'hideCard' | 'setCaptureExcluded'>;
  history: Pick<HistoryStore, 'append' | 'current'>;
  /** The folder context-helper writes this run's captures into; it must exist. */
  tempDir: () => string;
  /** A 512 px JPEG of a capture as base64, kept with the thread in history. */
  thumbnail: (jpeg: Buffer) => string;
  now: () => number;
  usage: (u: { input: number; output: number }) => void;
  /** Reads and deletes the capture files; the file system by default. */
  files?: { read(path: string): Promise<Buffer>; remove(path: string): Promise<void> };
}

/** Spec §7.1, §9.5: tool rounds per answer, the gap between a set of pings, and "the same spot". */
const MAX_ROUNDS = 6;
const PING_GAP_MS = 600;
const NEAR_PX = 40;
const RECEIVE_MS = 10_000;
const TOTAL_MS = 60_000;
const TITLE_MAX = 60;
/** The bubble sits up and to the right of the receipt, in DIPs. */
const BUBBLE_OFFSET = { x: 24, y: -24 };

const DONE: Part[] = [{ text: 'Done.' }];
const NOT_AVAILABLE: Part[] = [{ text: 'Not available.' }];
const INVALID: Part[] = [{ text: 'Ignored: the arguments were not valid.' }];
const OVER_LIMIT: Part[] = [{ text: 'Ignored: an answer has at most 6 pings and 1 emote.' }];

interface Run {
  machine: AskMachine;
  abort: AbortController;
  deadlines: Timer[];
  ended: boolean;
  spot: Spot;
  receipt: Point;
  display: { id: number; rect: Shot['display'] } | null;
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
  pings: number;
  /** Where its pings and emotes went (physical px): asking on one of them continues the thread. */
  marks: Point[];
  files: string[];
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

function toOverview(shot: Shot, p: Point): Point {
  const { display: d, overview: o } = shot;
  return { x: Math.round(((p.x - d.x) * o.w) / d.w), y: Math.round(((p.y - d.y) * o.h) / d.h) };
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
  private excluded = 0;

  constructor(private readonly deps: AskDeps) {
    super();
    this.files = deps.files ?? { read: (p) => readFile(p), remove: (p) => rm(p, { force: true }) };
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
    this.clearMarks();
    this.hideBubble();
    this.clearTimer('fade');
    this.deps.overlay.setMateTicket(machine.id);

    const current = this.deps.history.current();
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
      profile: null, shot: null, app: '', title: '', thumb: '', text: '', line: '', said: '', rest: '', markdown: [],
      tokens: null,
      calls: [], pings: 0, marks: [], files: [],
    };
    this.run = run;
    this.shown = run;
    this.nextPingAt = 0;
    this.bubbleEndsAt = 0;
    this.emit('state', true);
    if (this.cardShown) this.deps.windows.updateCard(this.cardState(run, true));
    void this.go(run);
  }

  /** What the bubble and card ask for; the rest (copy, link, history) is the app's to handle. */
  onTeammateAction(view: MateView, a: MateAction): void {
    const run = this.shown;
    switch (a.t) {
      case 'more':
        if (view === 'bubble' && run) this.openCard(run);
        break;
      case 'dismiss':
        this.hideBubble();
        break;
      case 'close':
        this.hideCard();
        break;
      case 'reply':
        if (run) this.ask({ ...run.spot, intent: 'generic' }, { text: a.text, newThread: false });
        break;
      case 'deep':
        if (run) this.ask({ ...run.spot, intent: 'allin' });
        break;
      default:
        break;
    }
  }

  /** Stops the running ask, if any, and clears everything the teammate has on screen. */
  cancel(_reason: 'new' | 'pause' | 'helper' | 'user'): void {
    this.stopRun();
    // Unconditionally: whatever the flags say, nothing of the teammate may stay on screen after a pause.
    this.marksShown = true;
    this.clearMarks();
    this.bubbleShown = true;
    this.hideBubble();
    this.cardShown = true;
    this.hideCard();
    this.clearTimer('fade');
    this.shown = null;
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
      for (const f of run.files) this.files.remove(f).catch(() => undefined);
    }
  }

  private async answer(run: Run): Promise<void> {
    const { deps } = this;
    const t = deps.settings().teammate;
    const profile = route(t, run.intent.def.deep);
    const key = profile && deps.secrets.available() ? deps.secrets.key(profile.id) : null;
    if (!profile || !key) return this.fail(run, 'noProfile');
    if (!run.display) return this.fail(run, 'capture');
    run.profile = profile;
    run.machine.startGathering();
    const signal = run.abort.signal;

    const fg = await deps.context.foreground(signal).catch(() => ({ app: '', title: '' }));
    if (!this.alive(run)) return;
    run.app = fg.app;
    run.title = fg.title;
    const cap = await this.capture(run, [run.spot.phys]);
    if (!this.alive(run)) return;
    const shot: Shot = { display: run.display.rect, overview: cap.overview, zooms: cap.zooms.map((z) => z.rect) };
    run.shot = shot;
    const overviewJpeg = await this.files.read(cap.overviewPath);
    const zoomJpegs = await Promise.all(cap.zooms.map((z) => this.files.read(z.path)));
    if (!this.alive(run)) return;
    run.thumb = deps.thumbnail(zoomJpegs[0] ?? overviewJpeg);

    const ctx: AskContext = {
      lang: run.lang, intent: run.intent, words: run.words, app: run.app, title: run.title, shot,
      spots: [toOverview(shot, run.spot.phys)], overviewJpeg, zoomJpegs, thread: run.thread,
      instructions: deps.secrets.instructions(), emotes: run.emotes,
    };
    const adapter = deps.adapter(profile, key);
    const system = systemPrompt(ctx);
    const tools = toolDefs({ emotes: run.emotes, spots: 1 });
    const turns: Turn[] = [firstTurn(ctx)];
    run.machine.sent();
    this.startDeadlines(run);

    for (let round = 0; round < MAX_ROUNDS; round += 1) {
      const result = await adapter.turn({ system, turns, tools, model: profile.model }, this.handlers(run), signal);
      if (!this.alive(run)) return;
      this.received(run); // a provider that streams nothing before its answer still gets a receipt
      run.machine.answering();
      run.text += result.text;
      turns.push({ role: 'assistant', text: result.text, calls: result.calls });
      const step = await this.play(run, result.calls, new Set(tools.map((d) => d.name)));
      if (!this.alive(run)) return;
      if (!step.again) break;
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
      usage: (u) => {
        // Tokens are spent even when the ask was cancelled, so they always count.
        this.deps.usage(u);
        run.tokens = (run.tokens ?? 0) + u.input + u.output;
      },
    };
  }

  private startDeadlines(run: Run): void {
    for (const ms of [RECEIVE_MS, TOTAL_MS]) {
      run.deadlines.push(setTimeout(() => {
        if (!this.alive(run)) return;
        const reason = run.machine.tick();
        if (reason) this.fail(run, reason);
      }, ms));
    }
  }

  /** Overlays and teammate windows stay out of the grab; a count, so an older ask's capture can't let them back in. */
  private async capture(run: Run, spots: Point[]): Promise<Capture> {
    const { overlay, windows, context } = this.deps;
    const rect = run.display?.rect;
    if (!rect) throw new ContextError('capture', 'no display under the spot');
    this.excluded += 1;
    if (this.excluded === 1) {
      overlay.setCaptureExcluded(true);
      windows.setCaptureExcluded(true);
    }
    try {
      const cap = await context.capture({ display: rect, spots, dir: this.deps.tempDir() }, run.abort.signal);
      run.files.push(cap.overviewPath, ...cap.zooms.map((z) => z.path));
      return cap;
    } finally {
      this.excluded -= 1;
      if (this.excluded === 0) {
        overlay.setCaptureExcluded(false);
        windows.setCaptureExcluded(false);
      }
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
    for (const { call } of valid) if (call.tool === 'say') this.say(run, call.text);
    for (const { call } of valid) if (call.tool === 'answer') this.addAnswer(run, call.markdown);
    const pings = valid.flatMap(({ call }) => (call.tool === 'ping' ? [call] : []));
    pings.sort((a, b) => (a.order ?? Infinity) - (b.order ?? Infinity));
    for (const p of pings) this.placePing(run, p);
    for (const { call } of valid) if (call.tool === 'emote') this.placeEmote(run, call);
    for (const { raw, call } of valid) {
      if (call.tool !== 'look') continue;
      again = true;
      results.set(raw, await this.look(run, call));
      if (!this.alive(run)) break;
    }
    return { again, results: raws.map((raw) => ({ id: raw.id, content: results.get(raw) ?? DONE })) };
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

  private target(run: Run, at: Target): { phys: Point; ring: boolean } | null {
    // The model numbers the user's spots from 1; an {x, y} guess is drawn as an area, not a precise point.
    if ('mark' in at) return at.mark === 1 ? { phys: run.spot.phys, ring: false } : null;
    const phys = run.shot ? overviewToPhysical(run.shot, at) : null;
    return phys ? { phys, ring: true } : null;
  }

  private placePing(run: Run, c: Extract<ToolCall, { tool: 'ping' }>): void {
    const point = this.target(run, c.at);
    const at = point ? this.deps.overlay.toLocal(point.phys) : null;
    if (!point || !at) return;
    run.marks.push(point.phys);
    const ping = {
      ...at, id: c.type, tag: run.tag,
      ...(point.ring ? { ring: true } : {}),
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
    const timer = setTimeout(() => {
      this.pingTimers.delete(timer);
      show();
    }, when - now);
    this.pingTimers.add(timer);
  }

  private placeEmote(run: Run, c: Extract<ToolCall, { tool: 'emote' }>): void {
    const point = this.target(run, c.at);
    const at = point ? this.deps.overlay.toLocal(point.phys) : null;
    if (!point || !at) return;
    run.marks.push(point.phys);
    this.deps.overlay.spawnMateEmote({ ...at, slug: c.slug, tag: run.tag });
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
    if (!run.line && run.markdown.length === 0 && run.marks.length === 0) return this.fail(run, 'other');
    if (!run.line) {
      this.deps.overlay.mateSaid(); // the thinking is over even without a line
      // Only an answer for the card: the bubble shows just its More button.
      if (run.markdown.length > 0 && !run.autoCard && !this.cardShown) this.showLine(run, '');
    }
    run.machine.done();
    this.stopRun();
    if (run.autoCard && !this.cardShown) this.openCard(run);
    else if (this.cardShown) this.deps.windows.updateCard(this.cardState(run, false));
    this.scheduleFade();
    const entry = {
      at: this.deps.now(), intent: run.spot.intent, words: run.words, line: run.said,
      markdown: run.markdown.join('\n\n'), thumb: run.thumb,
    };
    const meta = {
      title: (run.line || run.intent.label).slice(0, TITLE_MAX), app: run.app, windowTitle: run.title,
      profile: run.profile?.name ?? '',
    };
    await this.deps.history.append(run.thread?.id ?? null, entry, meta).catch(() => undefined);
  }

  private fail(run: Run, reason: AskFailure): void {
    run.machine.fail(reason);
    this.stopRun();
    this.clearMarks();
    const at = this.deps.overlay.toLocal(run.receipt);
    if (at) {
      this.deps.overlay.spawnMate({ ...at, id: 'missing', tag: run.tag });
      this.marksShown = true;
    }
    if (this.cardShown) this.deps.windows.updateCard(this.cardState(run, false));
    this.showLine(run, strings(run.lang).teammate.ask.failed[reason]);
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
    const state = this.bubbleState(run, line);
    if (this.bubbleShown) this.deps.windows.updateBubble(state);
    else this.deps.windows.showBubble(this.popupAt(run), state);
    this.bubbleShown = true;
    this.clearTimer('bubble');
    const ms = bubbleMs(line);
    this.bubbleEndsAt = this.deps.now() + ms;
    this.bubbleTimer = setTimeout(() => {
      this.bubbleTimer = null;
      this.hideBubble();
    }, ms);
  }

  private bubbleState(run: Run, line: string): BubbleState {
    return {
      view: 'bubble', lang: run.lang, tag: run.tag, line, thread: run.thread?.title ?? null, thinking: false,
      more: run.rest !== '' || run.markdown.length > 0,
    };
  }

  private openCard(run: Run): void {
    // The card grows out of the bubble, which goes.
    this.hideBubble();
    this.deps.windows.showCard(this.popupAt(run), this.cardState(run, this.alive(run)));
    this.cardShown = true;
  }

  private cardState(run: Run, streaming: boolean): CardState {
    const s = this.deps.settings().teammate;
    const t = strings(run.lang).teammate;
    const pair = (label: string, words: string | null, line: string, markdown: string): CardState['entries'] => [
      { kind: 'ask', label, markdown: words ?? '' },
      { kind: 'answer', label: run.tag.name, markdown: [line, markdown].filter(Boolean).join('\n\n') },
    ];
    const entries = (run.thread?.entries ?? []).flatMap((e) =>
      pair(intentFor(s, e.intent, run.lang).label, e.words, e.line, e.markdown));
    entries.push(...pair(run.intent.label, run.words, run.said, run.markdown.join('\n\n')));
    return {
      view: 'card', lang: run.lang, tag: run.tag, entries, streaming,
      title: run.thread?.title ?? (run.line || run.intent.label).slice(0, TITLE_MAX),
      footer: {
        profile: run.profile?.name ?? '', model: run.profile?.model ?? '', tokens: run.tokens, used: [t.ask.usedScreen],
      },
    };
  }

  private popupAt(run: Run): Point {
    const dip = this.deps.overlay.toDip(run.receipt) ?? { x: 0, y: 0 };
    return { x: dip.x + BUBBLE_OFFSET.x, y: dip.y + BUBBLE_OFFSET.y };
  }

  /** The receipt fades with the bubble, once the answer's pings have played out too. */
  private scheduleFade(): void {
    const now = this.deps.now();
    const pingMs = this.deps.settings().pingDurationS * 1000;
    const pingsEnd = this.nextPingAt > 0 ? this.nextPingAt - PING_GAP_MS + pingMs : 0;
    this.clearTimer('fade');
    this.fadeTimer = setTimeout(() => {
      this.fadeTimer = null;
      if (!this.marksShown) return;
      this.deps.overlay.fadeMate();
      this.marksShown = false;
    }, Math.max(0, this.bubbleEndsAt - now, pingsEnd - now));
  }

  private clearMarks(): void {
    for (const timer of this.pingTimers) clearTimeout(timer);
    this.pingTimers.clear();
    if (!this.marksShown) return;
    this.deps.overlay.clearMate();
    this.marksShown = false;
  }

  private hideBubble(): void {
    this.clearTimer('bubble');
    if (!this.bubbleShown) return;
    this.deps.windows.hideBubble();
    this.bubbleShown = false;
  }

  private hideCard(): void {
    if (!this.cardShown) return;
    this.deps.windows.hideCard();
    this.cardShown = false;
  }

  private clearTimer(which: 'bubble' | 'fade'): void {
    const timer = which === 'bubble' ? this.bubbleTimer : this.fadeTimer;
    if (timer) clearTimeout(timer);
    if (which === 'bubble') this.bubbleTimer = null;
    else this.fadeTimer = null;
  }
}

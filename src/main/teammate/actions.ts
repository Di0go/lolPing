import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { strings, type Lang, type Strings } from '../../shared/i18n';
import type { PingTag } from '../../shared/ipc';
import type { Platform } from '../../shared/platform';
import type { Settings } from '../../shared/settings';
import { SELECTION_MAX, type PasteResult } from '../../shared/teammate/contextProtocol';
import type { Rect } from '../../shared/teammate/coords';
import {
  agentAllowed, agentLabel, agentPermissionKey, agentWhat, allowed, describeAgentInput, formPreview, isEditTool,
  isShellTool, neverFill, pastePlan, permissionKey, type FormField, type LeftField, type PreviewRow, type PutAction,
} from '../../shared/teammate/doRules';
import { eventIcs, tableHtml, tableTsv } from '../../shared/teammate/grab';
import type { ActionCall } from '../../shared/teammate/tools';
import type { ConsentAction, FormAction, PutState } from '../../shared/teammateIpc';
import type { OverlayManager } from '../overlayManager';
import type { ContextClient } from './contextClient';
import { alwaysAllowsEdit } from './editScope';
import type { MateWindows } from './mateWindows';

type Point = { x: number; y: number };
type Copy = Extract<ActionCall, { tool: 'copy' }>;
type Paste = Extract<ActionCall, { tool: 'paste' }>;
type Fill = Extract<ActionCall, { tool: 'fill' }>;
type EventCall = Extract<ActionCall, { tool: 'event' }>;
type Open = Extract<ActionCall, { tool: 'open' }>;
type UiText = Strings['teammate']['ui'];

/** Spec §10.2: a card nobody answers in this time is a Decline. */
const CONSENT_MS = 30_000;
/** Spec §16: after a card that had focus closes, the ask's window has this long to come back to the front. */
const FRONT_WAIT_MS = 500;
const FRONT_POLL_MS = 50;
/** The consent card shows the start of what will be pasted. */
const DETAIL_MAX = 200;
/** A field's label on its ping, as long as the model's own ping labels. */
const PING_LABEL_MAX = 20;
/** The file or address in an agent's card question and history line. */
const WHAT_MAX = 120;

/** What the runner needs from the ask an action came from, all read when the ask was made. */
export interface RunInfo {
  /** The ask's id: a put button acts only on the answer it belongs to. */
  id: string;
  profileId: string;
  /** The profile's name, which the agent's consent card and history line call it by. */
  profileName: string;
  tag: PingTag;
  app: string;
  /** The window the ask was made in (an HWND in decimal on Windows): pastes and fills go only there. */
  window: string;
  lang: Lang;
  /** The spot in physical px, and in DIPs, where the consent card and the form preview go beside it. */
  spot: Point;
  at: Point;
  /** The element under the spot (physical px): where a paste glows when no field box is known. */
  box: Rect | null;
  /**
   * What had the keyboard at the ask (`kind` 'field' for a text field or combo box), with its text ('' for a secure
   * one); null when nothing did.
   */
  focus: { kind: string; label: string; value: string; secure: boolean } | null;
  /** The selection at the ask: what a replace pastes over. */
  selection: string;
  fields: FormField[];
  /** The folder an agent runs in: Always allow covers its edits only there. Null for a built-in profile. */
  cwd: string | null;
}

export interface ActionDeps {
  settings: () => Settings;
  savePermissions: (list: string[]) => void;
  context: Pick<ContextClient, 'paste' | 'setField' | 'foreground'>;
  clipboard: { write(item: { text: string; html?: string }): Promise<void> };
  /** Resolves with an error message, or '' when an app opened the file. */
  openPath: (file: string) => Promise<string>;
  showInFolder: (file: string) => void;
  openExternal: (url: string) => Promise<void>;
  writeFile: (file: string, text: string) => Promise<void>;
  /** The folder event files are written to. */
  tempDir: () => string;
  windows: Pick<MateWindows,
    'showConsent' | 'hideConsent' | 'showForm' | 'hideForm' | 'cardHadFocus' | 'hideCard' | 'hideBubble' | 'hideNow'>;
  overlay: Pick<OverlayManager, 'toast' | 'spawnMate' | 'toLocal' | 'glow'>;
  /** Which OS the toasts are worded for (the undo key), and whose paths an agent's edits name. */
  platform: Platform;
  /** The user's home folder, whose dot files Always allow never covers. */
  home: () => string;
  /** The local time minus UTC in minutes on a date, for event files. */
  zoneOffset: (d: Date) => number;
  now: () => number;
  /** Calls `fn` after `ms`; returns the way to stop it. */
  timer: (ms: number, fn: () => void) => () => void;
}

type Waiting =
  | { kind: 'consent'; run: RunInfo; call: Paste | EventCall | Open; action: Exclude<PutAction, 'fill'> }
  | { kind: 'form'; run: RunInfo; call: Fill }
  // `call` is absent: put() looks a paste's or fill's own card up by its call.
  | {
    kind: 'agent'; call?: undefined; run: RunInfo; tool: string; input: unknown;
    settle: (answer: 'allow' | 'deny') => void;
  };

interface Shown {
  item: Waiting;
  /** The serial the window gave the card or preview: an answer carrying another one was meant for an earlier card. */
  serial: number;
  stop: () => void;
  /** The rows and left fields the form preview lists. */
  preview: { rows: PreviewRow[]; left: LeftField[] } | null;
}

/** Why a paste copied instead. */
type CopyWhy = Exclude<PasteResult, 'ok' | 'hands'> | 'failed';

const centre = (r: Rect): Point => ({ x: Math.round(r.x + r.w / 2), y: Math.round(r.y + r.h / 2) });
const inside = (p: Point, r: Rect): boolean => p.x >= r.x && p.x < r.x + r.w && p.y >= r.y && p.y < r.y + r.h;
const lineCount = (text: string): number => text.split(/\r\n|\r|\n/).length;
const firstChars = (text: string, max: number): string => Array.from(text).slice(0, max).join('');

/** The text field under the spot, which a paste goes into. */
function fieldAt(run: RunInfo): FormField | null {
  const text = (f: FormField): boolean => f.kind === 'text' || f.kind === 'multiline';
  return run.fields.find((f) => text(f) && f.box !== undefined && inside(run.spot, f.box)) ?? null;
}

/**
 * Whether `field` had the keyboard at the ask, so a click into it would move the caret the user placed. The focus
 * carries no box, so the same label or the same text tells; a page (Chrome and Edge give the keyboard to the
 * document) is no field.
 */
function hadKeyboard(run: RunInfo, field: FormField): boolean {
  const f = run.focus;
  if (f === null || f.kind !== 'field') return false;
  const same = (a: string, b: string): boolean => a.trim() !== '' && a.trim() === b.trim();
  return same(f.label, field.label) || same(f.value, field.value);
}

function whyCopied(t: UiText, why: CopyWhy, app: string): string {
  switch (why) {
    case 'secure': return t.pasteSecure;
    case 'window': return t.pasteWindow;
    case 'selection': return t.pasteSelection;
    case 'hung': return t.pasteHung(app);
    case 'elevated': return t.pasteElevated(app);
    default: return t.pasteFailed;
  }
}

function detailOf(call: Paste | EventCall | Open): string {
  switch (call.tool) {
    case 'paste': return firstChars(call.text, DETAIL_MAX);
    case 'open': return new URL(call.url).href;
    case 'event': {
      const when = call.end ? `${call.start} – ${call.end}` : call.start;
      return [call.title, when.replace(/T/g, ' '), call.location ?? ''].filter((s) => s !== '').join('\n');
    }
  }
}

/**
 * Carries out the teammate's copy, event, paste, fill and open calls (spec §10). A copy runs at once. A paste, event or
 * open waits for its consent card (or Always allow); a fill always waits for its form preview. One card or preview is
 * up at a time, and the next waits until the action before it is done. Emits 'put' (PutState) when the bubble's and
 * card's put button changes, and again after a paste that did not land, so a bubble hidden for its click can come back
 * with the button. Emits 'described' (ask id, descriptions) each time an action of that ask is done, and 'asking'
 * (true, then false) while a consent card or form preview waits for the user. A coding agent's permission prompt
 * (askAgent) takes the same cards, one at a time with the rest.
 */
export class ActionRunner extends EventEmitter {
  private queue: Waiting[] = [];
  private shown: Shown | null = null;
  /** An action is running: the next card waits for it. */
  private busy = false;
  /** The paste or fill the put button carries out. */
  private target: { run: RunInfo; call: Paste | Fill } | null = null;
  private state: PutState = null;
  private ask: string | null = null;
  private done: string[] = [];
  private abort = new AbortController();
  /** Ends the foreground poll's wait at once: cancel() must not leave a timer behind. */
  private wake: (() => void) | null = null;
  private files = 0;

  constructor(private readonly deps: ActionDeps) {
    super();
  }

  get putState(): PutState {
    return this.state;
  }

  /** A tool call from an answer: copy runs at once; the rest wait for consent (or Always allow) or the preview. */
  take(run: RunInfo, call: ActionCall): void {
    this.begin(run);
    switch (call.tool) {
      case 'copy':
        this.copy(run, call).catch((err: unknown) => console.warn('[teammate] copy:', err));
        return;
      case 'paste':
        this.target = { run, call };
        this.setPut(call.mode === 'replace' ? 'replace' : 'paste');
        return this.enqueue({ kind: 'consent', run, call, action: 'paste' });
      case 'fill':
        this.target = { run, call };
        this.setPut('fill');
        return this.enqueue({ kind: 'form', run, call });
      case 'event':
      case 'open':
        return this.enqueue({ kind: 'consent', run, call, action: call.tool });
    }
  }

  /**
   * A coding agent's permission prompt: 'allow' once the user does (or Always allow covers it), 'deny' when they
   * decline, the card's 30 s run out, or the ask ends (`signal` aborts, or cancel()).
   */
  askAgent(run: RunInfo, req: { tool: string; input: unknown }, signal: AbortSignal): Promise<'allow' | 'deny'> {
    if (signal.aborted) return Promise.resolve('deny');
    this.begin(run);
    if (this.agentOk(run, req.tool, req.input)) {
      this.describeAgent(run, req.tool, req.input);
      return Promise.resolve('allow');
    }
    return new Promise((resolve) => {
      const item: Extract<Waiting, { kind: 'agent' }> = {
        kind: 'agent', run, tool: req.tool, input: req.input, settle: (answer) => {
          signal.removeEventListener('abort', gone);
          resolve(answer);
        },
      };
      const gone = (): void => this.drop(item);
      signal.addEventListener('abort', gone, { once: true });
      this.enqueue(item);
    });
  }

  /** The bubble's or card's Paste / Replace / Fill button: the user's click is the consent. */
  async put(run: RunInfo, _from: 'bubble' | 'card'): Promise<void> {
    const target = this.target;
    if (!target || target.run.id !== run.id || this.state === null || this.busy) return;
    const { call } = target;
    if (call.tool === 'fill') {
      // Fill always goes through its preview, which the click opens again.
      if (this.shown?.item.call === call || this.queue.some((i) => i.call === call)) return;
      this.queue.unshift({ kind: 'form', run: target.run, call });
      return this.pump();
    }
    // Its own card, shown or waiting, is answered by the click; another card waits until the paste is over.
    this.queue = this.queue.filter((i) => i.call !== call);
    const shown = this.shown;
    if (shown) {
      this.closeShown();
      if (shown.item.call !== call) this.queue.unshift(shown.item);
    }
    await this.runNow((signal) => this.paste(target.run, call, signal));
  }

  /** Consent and preview answers from their windows. */
  onAction(view: 'consent' | 'form', a: ConsentAction | FormAction): void {
    const shown = this.shown;
    if (!shown) return;
    const { item } = shown;
    // A click that left an earlier card as this one replaced it is not an answer to this one.
    if (a.serial !== shown.serial) return;
    if (view === 'consent' && item.kind === 'agent') {
      if (a.t !== 'allow' && a.t !== 'always' && a.t !== 'decline') return;
      this.closeShown();
      if (a.t === 'decline') {
        item.settle('deny');
      } else {
        // A shell command is never remembered: the card doesn't offer it, and a stray click is only Allow once.
        if (a.t === 'always' && !isShellTool(item.tool)) this.rememberAgent(item.run.profileId, item.tool);
        this.describeAgent(item.run, item.tool, item.input);
        item.settle('allow');
      }
      return this.pump();
    }
    if (view === 'consent' && item.kind === 'consent') {
      if (a.t !== 'allow' && a.t !== 'always' && a.t !== 'decline') return;
      this.closeShown();
      // A Decline keeps the put button, so the user can still paste later.
      if (a.t === 'decline') return this.pump();
      if (a.t === 'always') this.remember(item.run.profileId, item.action);
      void this.runNow((signal) => this.execute(item, signal));
    } else if (view === 'form' && item.kind === 'form' && shown.preview) {
      if (a.t !== 'fill' && a.t !== 'cancel') return;
      this.closeShown();
      if (a.t === 'cancel') return this.pump();
      const { preview } = shown;
      const ids = new Set(a.ids);
      void this.runNow((signal) => this.fill(item.run, item.call, preview, ids, signal));
    }
  }

  /** A new ask, pause or quit: pending consent and preview go away, nothing runs. */
  cancel(): void {
    this.abort.abort();
    this.abort = new AbortController();
    this.wake?.();
    const pending = [...this.queue, ...(this.shown ? [this.shown.item] : [])];
    this.queue = [];
    this.closeShown();
    // An agent left waiting would hold its bridge call open.
    for (const item of pending) if (item.kind === 'agent') item.settle('deny');
    this.busy = false;
    this.target = null;
    this.setPut(null);
    this.ask = null;
    this.done = [];
  }

  /** For history: "Pasted 2 lines into Chrome", "Filled 5 fields, left 2", "Copied a table, 3 × 4". */
  described(): string[] {
    return [...this.done];
  }

  /** The first call of an ask starts its list of what was done. */
  private begin(run: RunInfo): void {
    if (run.id !== this.ask) {
      this.ask = run.id;
      this.done = [];
    }
  }

  private enqueue(item: Waiting): void {
    this.queue.push(item);
    this.pump();
  }

  /** Shows the next card or preview, or runs the next action the user always allows. */
  private pump(): void {
    if (this.shown || this.busy) return;
    const item = this.queue.shift();
    if (!item) return;
    if (item.kind === 'form') return this.showPreview(item);
    if (item.kind === 'agent') {
      // Checked now, not when the call came: Always allow on one card covers the next one waiting.
      if (!this.agentOk(item.run, item.tool, item.input)) return this.showAgent(item);
      this.describeAgent(item.run, item.tool, item.input);
      item.settle('allow');
      return this.pump();
    }
    // Checked now, not when the call came: Always allow on one card covers the next one waiting.
    if (allowed(this.deps.settings().teammate.permissions, item.run.profileId, item.action)) {
      void this.runNow((signal) => this.execute(item, signal));
      return;
    }
    this.showConsent(item);
  }

  private runNow(work: (signal: AbortSignal) => Promise<void>): Promise<void> {
    this.busy = true;
    const { signal } = this.abort;
    return work(signal)
      .catch((err: unknown) => console.warn('[teammate] action:', err))
      .finally(() => {
        if (signal.aborted) return; // cancel() has reset everything already
        this.busy = false;
        this.pump();
      });
  }

  private execute(item: Extract<Waiting, { kind: 'consent' }>, signal: AbortSignal): Promise<void> {
    const { run, call } = item;
    switch (call.tool) {
      case 'paste': return this.paste(run, call, signal);
      case 'event': return this.event(run, call, signal);
      case 'open': return this.open(run, call, signal);
    }
  }

  private text(run: RunInfo): Strings['teammate']['ui'] {
    return strings(run.lang, this.deps.platform).teammate.ui;
  }

  private showConsent(item: Extract<Waiting, { kind: 'consent' }>): void {
    const { run, call } = item;
    const t = this.text(run);
    const app = run.app || t.thisApp;
    let text = t.consentOpen;
    if (call.tool === 'paste') text = call.mode === 'replace' ? t.consentReplace(app) : t.consentPaste(app);
    else if (call.tool === 'event') text = t.consentEvent;
    const serial = this.deps.windows.showConsent(run.at, {
      view: 'consent', lang: run.lang, tag: run.tag, action: item.action, text, detail: detailOf(call), always: true,
      seconds: CONSENT_MS / 1000,
    });
    const stop = this.deps.timer(CONSENT_MS, () => {
      if (this.shown?.item !== item) return;
      this.closeShown(); // a Decline
      this.pump();
    });
    this.shown = { item, serial, stop, preview: null };
    this.emit('asking', true);
  }

  private showAgent(item: Extract<Waiting, { kind: 'agent' }>): void {
    const { run, tool, input } = item;
    const detail = describeAgentInput(tool, input);
    const serial = this.deps.windows.showConsent(run.at, {
      view: 'consent', lang: run.lang, tag: run.tag, action: 'agent', tool,
      text: this.agentLine(run, tool, input, false), detail: detail.text,
      always: !isShellTool(tool), seconds: CONSENT_MS / 1000,
      ...(isEditTool(tool) && !this.editCovered(run, tool, input) ? { alwaysAsks: true } : {}),
      ...(detail.moreLines > 0 ? { moreLines: detail.moreLines } : {}),
      ...(detail.moreEdits > 0 ? { moreEdits: detail.moreEdits } : {}),
    });
    const stop = this.deps.timer(CONSENT_MS, () => {
      if (this.shown?.item !== item) return;
      this.closeShown();
      item.settle('deny');
      this.pump();
    });
    this.shown = { item, serial, stop, preview: null };
    this.emit('asking', true);
  }

  /** The card's question ("Claude Code wants to edit src/app.ts"), or with `done` the history line. */
  private agentLine(run: RunInfo, tool: string, input: unknown, done: boolean): string {
    const t = this.text(run);
    const { kind, target } = agentWhat(tool, input);
    const what = agentLabel(target, WHAT_MAX);
    const name = run.profileName;
    switch (kind) {
      case 'edit': return done ? t.didAgentEdit(name, what) : t.agentEdit(name, what);
      case 'run': return done ? t.didAgentRun(name) : t.agentRun(name);
      case 'open': return done ? t.didAgentOpen(name, what) : t.agentOpen(name, what);
      case 'use': return done ? t.didAgentUse(name, tool) : t.agentUse(name, tool);
    }
  }

  private describeAgent(run: RunInfo, tool: string, input: unknown): void {
    this.describe(run, this.agentLine(run, tool, input, true));
  }

  /** The ask ended with this prompt unanswered: its card goes, or its place in the line is given up. */
  private drop(item: Extract<Waiting, { kind: 'agent' }>): void {
    this.queue = this.queue.filter((i) => i !== item);
    const was = this.shown?.item === item;
    if (was) this.closeShown();
    item.settle('deny');
    if (was) this.pump();
  }

  private agentOk(run: RunInfo, tool: string, input: unknown): boolean {
    if (!agentAllowed(this.deps.settings().teammate.permissions, run.profileId, tool)) return false;
    return !isEditTool(tool) || this.editCovered(run, tool, input);
  }

  /** An edit outside the run's folder, or of a settings file, asks even with Always allow saved (ruling R26). */
  private editCovered(run: RunInfo, tool: string, input: unknown): boolean {
    const { kind, target } = agentWhat(tool, input);
    return kind === 'edit' && alwaysAllowsEdit(target, run.cwd, this.deps.home(), this.deps.platform);
  }

  private showPreview(item: Extract<Waiting, { kind: 'form' }>): void {
    const { run, call } = item;
    const preview = formPreview(run.fields, call.fields);
    const serial = this.deps.windows.showForm(run.at, {
      view: 'form', lang: run.lang, tag: run.tag, app: run.app || this.text(run).thisApp, ...preview,
    });
    this.shown = { item, serial, stop: () => undefined, preview };
    this.emit('asking', true);
  }

  private closeShown(): void {
    const shown = this.shown;
    if (!shown) return;
    this.shown = null;
    shown.stop();
    if (shown.item.kind === 'form') this.deps.windows.hideForm();
    else this.deps.windows.hideConsent();
    this.emit('asking', false);
  }

  private remember(profileId: string, action: PutAction): void {
    const list = this.deps.settings().teammate.permissions;
    const key = permissionKey(profileId, action);
    if (!list.includes(key)) this.deps.savePermissions([...list, key]);
  }

  private rememberAgent(profileId: string, tool: string): void {
    const list = this.deps.settings().teammate.permissions;
    const key = agentPermissionKey(profileId, tool);
    if (!list.includes(key)) this.deps.savePermissions([...list, key]);
  }

  /** `again`: tell the bubble and card even when the button stays the same. */
  private setPut(state: PutState, again = false): void {
    if (state === this.state && !again) return;
    this.state = state;
    this.emit('put', state);
  }

  /** History keeps what was done, never the text (spec §8.2). */
  private describe(run: RunInfo, text: string): void {
    if (run.id !== this.ask) return;
    this.done.push(text);
    this.emit('described', run.id, [...this.done]);
  }

  private toast(run: RunInfo, ...sentences: string[]): void {
    const body = sentences.filter((s) => s !== '').join(run.lang === 'en' ? ' ' : '');
    this.deps.overlay.toast(run.tag.name, body);
  }

  private async copy(run: RunInfo, call: Copy): Promise<void> {
    const t = this.text(run);
    if ('table' in call) {
      const rows = call.table.length;
      const cols = call.table[0]?.length ?? 0;
      if (!(await this.write(run, { text: tableTsv(call.table), html: tableHtml(call.table) }))) return;
      this.toast(run, t.copiedTable(rows, cols));
      this.describe(run, t.didCopyTable(rows, cols));
      return;
    }
    if (!(await this.write(run, { text: call.text }))) return;
    this.toast(run, t.copiedText);
    this.describe(run, t.didCopyText(lineCount(call.text)));
  }

  private async write(run: RunInfo, item: { text: string; html?: string }, extra = ''): Promise<boolean> {
    try {
      await this.deps.clipboard.write(item);
      return true;
    } catch {
      this.toast(run, this.text(run).copyFailed, extra);
      return false;
    }
  }

  /** Spec §10.3 with §16: the clipboard route, run whole in the context helper, or a copy that says why. */
  private async paste(run: RunInfo, call: Paste, signal: AbortSignal): Promise<void> {
    const t = this.text(run);
    const field = fieldAt(run);
    const secure = (run.focus !== null && neverFill(run.focus)) || (field !== null && neverFill(field));
    // Without the ask's window there is nothing to paste into: say so plainly, not that the user moved.
    if (run.window === '') return this.copyInstead(run, call.text, 'failed');
    const sameWindow = await this.askWindowInFront(run, signal);
    if (signal.aborted) return;
    // The helper compares the live selection with the asked one; here it only matters that there was one, read whole:
    // both sides are cut at the cap, so two long selections that differ past it would compare equal.
    const asked = Array.from(run.selection).length >= SELECTION_MAX ? '' : run.selection;
    const plan = pastePlan({ mode: call.mode, secure, sameWindow, selectionNow: asked, selectionAsked: asked });
    if (plan.method === 'copy') return this.copyInstead(run, call.text, plan.why ?? 'failed');
    // A click puts the caret in the text field under the spot unless that field had the keyboard already. A replace
    // never clicks: that would drop the selection it pastes over.
    const click = call.mode === 'insert' && field?.box && !hadKeyboard(run, field) ? centre(field.box) : null;
    if (click) this.clearForClick();
    let reply: Awaited<ReturnType<ActionDeps['context']['paste']>>;
    try {
      reply = await this.deps.context.paste({
        window: run.window, text: call.text, click, ...(click && field ? { field: field.id } : {}), mode: call.mode,
        asked: call.mode === 'replace' ? run.selection : '',
      }, signal);
    } catch {
      if (signal.aborted) return;
      return this.copyInstead(run, call.text, 'failed');
    }
    if (signal.aborted) return;
    // Hands still on the keys after 3 s: nothing was sent, and the button pastes once they are off.
    if (reply.result === 'hands') return this.setPut('ready', true);
    const lost = reply.restored ? '' : t.clipboardNotRestored;
    if (reply.result !== 'ok') return this.copyInstead(run, call.text, reply.result, lost);
    this.toast(run, t.pasted, lost);
    const box = field?.box ?? run.box;
    if (box) this.deps.overlay.glow([box], run.tag);
    this.describe(run, t.didPaste(lineCount(call.text), run.app || t.thisApp));
    this.setPut(null);
  }

  /**
   * lolPing's own window over the click point would make the helper refuse, and a card or preview still fading out
   * counts: they go at once, and the bubble through the controller, which brings it back if the paste doesn't land.
   */
  private clearForClick(): void {
    this.deps.windows.hideBubble();
    this.deps.windows.hideNow('consent');
    this.deps.windows.hideNow('form');
  }

  private async copyInstead(run: RunInfo, text: string, why: CopyWhy, extra = ''): Promise<void> {
    const t = this.text(run);
    // A password field stays one: a later click on Paste would only copy again. Any other refusal keeps the button.
    if (why === 'secure') this.setPut(null);
    else if (this.state !== null) this.setPut(this.state, true);
    if (!(await this.write(run, { text }, extra))) return;
    this.toast(run, whyCopied(t, why, run.app || t.thisApp), extra);
    this.describe(run, t.didCopyText(lineCount(text)));
  }

  /**
   * Whether the ask's window is in front. A card that had focus keeps the foreground until it is closed, so it is
   * closed first and the window gets up to FRONT_WAIT_MS to come back (spec §16).
   */
  private async askWindowInFront(run: RunInfo, signal: AbortSignal): Promise<boolean> {
    const card = this.deps.windows.cardHadFocus();
    if (card) this.deps.windows.hideCard();
    const until = this.deps.now() + (card ? FRONT_WAIT_MS : 0);
    for (;;) {
      const front = await this.deps.context.foreground(signal).catch(() => null);
      if (run.window !== '' && front?.window === run.window) return true;
      if (signal.aborted || this.deps.now() >= until) return false;
      await new Promise<void>((resolve) => {
        const stop = this.deps.timer(FRONT_POLL_MS, () => {
          this.wake = null;
          resolve();
        });
        this.wake = () => {
          this.wake = null;
          stop();
          resolve();
        };
      });
    }
  }

  /** Writes the checked rows one by one; never presses Submit (spec §10.4). */
  private async fill(
    run: RunInfo, call: Fill, preview: { rows: PreviewRow[]; left: LeftField[] }, ids: ReadonlySet<string>,
    signal: AbortSignal,
  ): Promise<void> {
    const t = this.text(run);
    const forms = this.deps.settings().teammate.context.clipboardForForms;
    // Closes a card that had focus. Fields are found by id, so the fill goes on either way; a paste checks for itself.
    await this.askWindowInFront(run, signal);
    if (signal.aborted) return;
    const byId = new Map(run.fields.map((f) => [f.id, f]));
    const filled: FormField[] = [];
    const failed: FormField[] = [];
    let lost = false;
    let stopped = false;
    for (const row of preview.rows) {
      const field = byId.get(row.id);
      if (!ids.has(row.id) || !field) continue;
      if (stopped) {
        failed.push(field);
        continue;
      }
      let result = await this.deps.context.setField({ window: run.window, field: field.id, value: row.value }, signal)
        .catch(() => 'error' as const);
      if (signal.aborted) return;
      const text = field.kind === 'text' || field.kind === 'multiline';
      if (result === 'refused' && forms && text && field.box) {
        const pasted = await this.pasteInto(run, field, field.box, row.value, signal);
        if (signal.aborted) return;
        lost ||= !pasted.restored;
        result = pasted.result;
      }
      if (result === 'ok') filled.push(field);
      else failed.push(field);
      // The window went away or stopped answering: every field after this would fail the same way, slowly.
      if (result === 'window' || result === 'hung' || result === 'error') stopped = true;
    }
    const listed = new Set(preview.rows.map((r) => r.id));
    const leftByPreview = call.fields.flatMap(({ id }) => {
      const field = listed.has(id) ? undefined : byId.get(id);
      return field ? [field] : [];
    });
    this.pingFields(run, filled, [...failed, ...leftByPreview]);
    // In the order they were filled.
    const boxes = filled.flatMap((f) => (f.box ? [f.box] : []));
    if (boxes.length > 0) this.deps.overlay.glow(boxes, run.tag);
    this.toast(run, filled.length > 0 ? t.filled(filled.length) : t.filledNone, lost ? t.clipboardNotRestored : '');
    this.describe(run, t.didFill(filled.length, failed.length + preview.left.length));
    this.setPut(null);
  }

  /** A text field that refuses its value gets it by the clipboard route, with a click on the field. */
  private async pasteInto(
    run: RunInfo, field: FormField, box: Rect, text: string, signal: AbortSignal,
  ): Promise<{ result: 'ok' | 'refused' | 'hung' | 'error'; restored: boolean }> {
    this.clearForClick();
    try {
      const r = await this.deps.context.paste(
        { window: run.window, text, click: centre(box), field: field.id, mode: 'insert', asked: '' }, signal);
      // An app that stopped answering stops the fill, as it does for setField. `window` here may only mean something
      // else is under this field's point; if the window itself went away, the next setField says so and stops it.
      const result = r.result === 'ok' || r.result === 'hung' ? r.result : 'refused';
      return { result, restored: r.restored };
    } catch {
      return { result: 'error', restored: true };
    }
  }

  /** Vision Cleared on each filled field and Enemy Missing on each one left for the user, labelled with the field. */
  private pingFields(run: RunInfo, filled: FormField[], left: FormField[]): void {
    const marks = [
      ...filled.map((field) => ({ id: 'visioncleared' as const, field })),
      ...left.map((field) => ({ id: 'missing' as const, field })),
    ];
    let first = true;
    for (const { id, field } of marks) {
      const at = field.box ? this.deps.overlay.toLocal(centre(field.box)) : null;
      if (!at) continue;
      const label = firstChars(field.label.trim(), PING_LABEL_MAX);
      this.deps.overlay.spawnMate({
        ...at, id, ...(label ? { label } : {}), tag: run.tag,
        ...(first ? {} : { silent: true }), // one sound for the whole set
      });
      first = false;
    }
  }

  private async event(run: RunInfo, call: EventCall, signal: AbortSignal): Promise<void> {
    const t = this.text(run);
    const now = this.deps.now();
    this.files += 1;
    const ics = eventIcs(call, { uid: `${now}-${this.files}@lolping`, now, zoneOffset: this.deps.zoneOffset });
    if (ics === null) return this.toast(run, t.eventFailed);
    const file = join(this.deps.tempDir(), `event-${now}-${this.files}.ics`);
    try {
      await this.deps.writeFile(file, ics);
    } catch {
      if (!signal.aborted) this.toast(run, t.eventFailed);
      return;
    }
    if (signal.aborted) return;
    const error = await this.deps.openPath(file);
    if (signal.aborted) return;
    // No app took the file (no calendar app): show it, so the user can open it themselves.
    if (error !== '') {
      this.deps.showInFolder(file);
      this.toast(run, t.eventOpenFile);
    }
    this.describe(run, t.didEvent);
  }

  private async open(run: RunInfo, call: Open, signal: AbortSignal): Promise<void> {
    const t = this.text(run);
    try {
      await this.deps.openExternal(new URL(call.url).href);
    } catch {
      if (!signal.aborted) this.toast(run, t.openFailed);
      return;
    }
    if (signal.aborted) return;
    this.describe(run, t.didOpen);
  }
}

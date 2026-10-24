import type { Lang } from './i18n';
import type { PingTag } from './ipc';
import type { PingId } from './pings';
import type { Platform } from './platform';
import { FIELD_ID_MAX, type LeftField, type PreviewRow, type PutAction } from './teammate/doRules';

/** state, leave (play the closing motion; the window hides after it): main → page. action, size: page → main. */
export const TEAMMATE_CH = {
  state: 'mate:state', leave: 'mate:leave', action: 'mate:action', size: 'mate:size', drag: 'mate:drag',
} as const;

/** How a bubble or card leaves: the quick close, or the slow fade of a stale signal. */
export type MateLeave = 'fast' | 'stale';

export type MateView = 'bubble' | 'card' | 'history' | 'words' | 'consent' | 'form';

/** The words box at the spot: what the user types becomes an ask. */
export interface WordsState {
  view: 'words';
  lang: Lang;
  tag: PingTag;
  /** The current thread's title, shown as "↳ title"; null when there is none. */
  thread: string | null;
  /** The New thread switch starts off: the thread had activity in the last few minutes. */
  continueByDefault: boolean;
}

/** The put button the bubble and card show: Paste, Replace, Fill, Paste when ready, or none. */
export type PutState = 'paste' | 'replace' | 'fill' | 'ready' | null;

export interface BubbleState {
  view: 'bubble';
  lang: Lang;
  tag: PingTag;
  line: string;
  thread: string | null;
  /** No line yet: the name tag shows dots. */
  thinking: boolean;
  /** There is more than the line: the More button is shown. */
  more: boolean;
  put: PutState;
}

export interface CardState {
  view: 'card';
  lang: Lang;
  tag: PingTag;
  title: string;
  /** An answer's `line` is the bubble's line, shown above its Markdown; an ask's `markdown` is the user's words. */
  entries: { kind: 'ask' | 'answer'; label: string; markdown: string; line?: string }[];
  streaming: boolean;
  footer: { profile: string; model: string; route: string; tokens: number | null; used: string[] };
  put: PutState;
  /** An agent's unprompted answer: no reply box and no Whole picture, which would ask the user's own teammate. */
  answerOnly?: boolean;
}

/** One thread in the History window's list. */
export interface HistoryThread {
  id: string;
  title: string;
  lastActivity: number;
  app: string;
  intents: PingId[];
  /** The agent profile's name when the thread's session can be opened in a terminal; the button reads "Open in" it. */
  agent?: string;
}

export interface HistoryState {
  view: 'history';
  lang: Lang;
  /** false: history is off, and `off` says why. */
  available: boolean;
  off?: 'disabled' | 'unavailable';
  /** The search the list was made for, so the box shows what the list matches. */
  query: string;
  threads: HistoryThread[];
  /** The agent profile's name when its Open in just failed: the window tells the user in one line. */
  openFailed?: string;
}

/** "Paste this into Chrome?": the teammate asks before it acts. The window never takes the keyboard. */
export interface ConsentState {
  view: 'consent';
  lang: Lang;
  tag: PingTag;
  /** What is asked: a teammate's action, or 'agent' for a coding agent's permission prompt. */
  action: PutAction | 'agent';
  /** The agent's tool, when `action` is 'agent'. */
  tool?: string;
  /** The question, already worded for the action ("Paste your reply into Chrome?"). */
  text: string;
  /** What will be pasted (its first 200 characters), the URL, the event's title and time, or an agent's command. */
  detail: string;
  /** Offer Always allow. */
  always: boolean;
  /** An agent's edit outside its folder or of a settings file: the card says lolPing asks each time. */
  alwaysAsks?: boolean;
  /** Lines of an agent's command or edit, and edits of a MultiEdit, that the detail left out; absent when none. */
  moreLines?: number;
  moreEdits?: number;
  /** The countdown bar's total length; ending it is the caller's job, the page only draws it. */
  seconds: number;
  /** Which side of the spot the card is on, so it slides in from there. Set by the window; the right when absent. */
  side?: 'left' | 'right';
  /** Changes with every new card, so the page starts its slide and countdown again. Set by the window. */
  serial?: number;
}

/** "Fill this form in Chrome?": the fields the teammate will fill, each with a checkbox, and those left to the user. */
export interface FormState {
  view: 'form';
  lang: Lang;
  tag: PingTag;
  app: string;
  rows: PreviewRow[];
  left: LeftField[];
  /** Which side of the spot the window is on, so it slides in from there. Set by the window; the right when absent. */
  side?: 'left' | 'right';
  /** Changes with every new preview, so the page starts its slide and its ticks again. Set by the window. */
  serial?: number;
}

export type MateState = BubbleState | CardState | WordsState | HistoryState | ConsentState | FormState;

/**
 * What the consent card sends, with the serial of the card it was clicked on: a click that arrives after that card
 * was decided, and another one shown in its place, must not answer the new one.
 */
export type ConsentAction =
  | { t: 'allow'; serial: number } | { t: 'always'; serial: number } | { t: 'decline'; serial: number };

/** What the form preview sends: the ids of the checked rows, or nothing; with its serial, as the consent card's. */
export type FormAction = { t: 'fill'; ids: string[]; serial: number } | { t: 'cancel'; serial?: number };

export type MateAction =
  | { t: 'more' }
  | { t: 'dismiss' }
  | { t: 'close' }
  | { t: 'copy'; text: string }
  | { t: 'reply'; text: string }
  | { t: 'deep' }
  | { t: 'history' }
  | { t: 'link'; url: string }
  | { t: 'ask'; text: string; newThread: boolean }
  | { t: 'cancel' }
  | { t: 'open'; id: string }
  | { t: 'continue'; id: string }
  | { t: 'delete'; id: string }
  | { t: 'openInAgent'; id: string }
  | { t: 'search'; query: string }
  /** The bubble's or card's put button: the click is the user's consent to that paste or fill. */
  | { t: 'put' }
  | ConsentAction
  | FormAction;

export interface MateApi {
  /** The OS, for wording that differs on macOS. */
  platform: Platform;
  /** Calls `cb` with every state the main process sends; returns the way to stop. */
  on(cb: (state: MateState) => void): () => void;
  /** Calls `cb` when the window is about to hide; returns the way to stop. */
  onLeave(cb: (how: MateLeave) => void): () => void;
  act(action: MateAction): void;
  /** The page's content size in DIPs, so a transparent window doesn't cover more of the screen than it draws. */
  size(size: { width: number; height: number }): void;
  /** The user drags the bubble or card: the window moves by the pointer's offset from where the drag started. */
  drag(d: MateDrag): void;
}

/**
 * A drag of the bubble or card, in DIPs from where it started. Windows can't drag a window that never takes focus by a
 * CSS drag region, so the page reports the pointer and the main process moves the window.
 */
export interface MateDrag {
  phase: 'start' | 'move' | 'end';
  dx: number;
  dy: number;
}

/** Longest words the user may type for an ask or a reply. */
export const MATE_TEXT_MAX = 2000;
/** A card's whole text can be copied; anything longer than this is not a real answer. */
export const MATE_COPY_MAX = 100_000;
const URL_MAX = 2048;
const QUERY_MAX = 200;
/** The most fields one fill may name (the plan's limit); each id is at most FIELD_ID_MAX long. */
const FILL_IDS_MAX = 60;
/** The same rule as HistoryStore uses before an id reaches a file name. */
const THREAD_ID_RE = /^[A-Za-z0-9-]{1,64}$/;

/**
 * What each window may ask for: the words box asks, the card replies, the bubble opens or closes, the rest decide. The
 * bubble and card also carry the put button.
 */
const ALLOWED: Record<MateView, ReadonlySet<MateAction['t']>> = {
  bubble: new Set(['more', 'dismiss', 'put']),
  card: new Set(['close', 'copy', 'reply', 'deep', 'history', 'link', 'put']),
  words: new Set(['ask', 'cancel']),
  history: new Set(['open', 'continue', 'delete', 'search', 'openInAgent']),
  consent: new Set(['allow', 'always', 'decline']),
  form: new Set(['fill', 'cancel']),
};

/** Size limits in DIPs for the windows that fit their content. */
const SIZE_LIMITS: Partial<Record<MateView, { minW: number; maxW: number; minH: number; maxH: number }>> = {
  bubble: { minW: 160, maxW: 440, minH: 40, maxH: 220 },
  card: { minW: 200, maxW: 480, minH: 60, maxH: 600 },
  consent: { minW: 200, maxW: 480, minH: 60, maxH: 400 },
  form: { minW: 200, maxW: 420, minH: 60, maxH: 520 },
};

const words = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '' && v.length <= MATE_TEXT_MAX;
const isSerial = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const threadId = (v: unknown): v is string => typeof v === 'string' && THREAD_ID_RE.test(v);

function webUrl(v: unknown): string | null {
  if (typeof v !== 'string' || v.length > URL_MAX) return null;
  try {
    const u = new URL(v);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null;
  } catch {
    return null;
  }
}

function parse(a: Record<string, unknown>): MateAction | null {
  switch (a.t) {
    case 'more':
    case 'dismiss':
    case 'close':
    case 'deep':
    case 'history':
    case 'put':
      return { t: a.t };
    case 'cancel':
      return isSerial(a.serial) ? { t: 'cancel', serial: a.serial } : { t: 'cancel' };
    case 'allow':
    case 'always':
    case 'decline':
      return isSerial(a.serial) ? { t: a.t, serial: a.serial } : null;
    case 'copy':
      return typeof a.text === 'string' && a.text.length <= MATE_COPY_MAX ? { t: 'copy', text: a.text } : null;
    case 'reply':
      return words(a.text) ? { t: 'reply', text: a.text } : null;
    case 'ask':
      return words(a.text) && typeof a.newThread === 'boolean' ? { t: 'ask', text: a.text, newThread: a.newThread } : null;
    case 'link': {
      const url = webUrl(a.url);
      return url ? { t: 'link', url } : null;
    }
    case 'open':
    case 'continue':
    case 'delete':
    case 'openInAgent':
      return threadId(a.id) ? { t: a.t, id: a.id } : null;
    case 'fill': {
      const ids: unknown = a.ids;
      if (!Array.isArray(ids) || ids.length < 1 || ids.length > FILL_IDS_MAX) return null;
      const list: string[] = [];
      for (const id of ids as unknown[]) {
        if (typeof id !== 'string' || id === '' || id.length > FIELD_ID_MAX) return null;
        list.push(id);
      }
      return isSerial(a.serial) ? { t: 'fill', ids: list, serial: a.serial } : null;
    }
    case 'search':
      return typeof a.query === 'string' && a.query.length <= QUERY_MAX ? { t: 'search', query: a.query } : null;
    default:
      return null;
  }
}

/** A teammate window is only a view: what it sends is checked here from `unknown`, against what that view may send. */
export function parseMateAction(raw: unknown, view: MateView): MateAction | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const action = parse(raw as Record<string, unknown>);
  if (!action || !ALLOWED[view].has(action.t)) return null;
  // The form preview's Cancel is a decision too: it carries its preview's serial, as every decision does.
  if (view === 'form' && action.t === 'cancel' && !('serial' in action)) return null;
  return action;
}

/** Farther than any desktop: a bigger offset is not a drag. */
const DRAG_MAX = 20_000;

/** A drag a page reported; only the bubble and the card can be dragged. */
export function parseMateDrag(raw: unknown, view: MateView): MateDrag | null {
  if ((view !== 'bubble' && view !== 'card') || typeof raw !== 'object' || raw === null) return null;
  const { phase, dx, dy } = raw as Record<string, unknown>;
  if (phase !== 'start' && phase !== 'move' && phase !== 'end') return null;
  const ok = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= DRAG_MAX;
  return ok(dx) && ok(dy) ? { phase, dx: Math.round(dx), dy: Math.round(dy) } : null;
}

/** A size a page reported, clamped to its view's limits; null for views with a fixed size or a bad report. */
export function parseMateSize(raw: unknown, view: MateView): { width: number; height: number } | null {
  const limits = SIZE_LIMITS[view];
  if (!limits || typeof raw !== 'object' || raw === null) return null;
  const { width, height } = raw as Record<string, unknown>;
  const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
  if (!num(width) || !num(height)) return null;
  const clamp = (v: number, min: number, max: number): number => Math.round(Math.max(min, Math.min(v, max)));
  return { width: clamp(width, limits.minW, limits.maxW), height: clamp(height, limits.minH, limits.maxH) };
}

import type { Lang } from './i18n';
import type { PingTag } from './ipc';
import type { PingId } from './pings';
import type { PutAction } from './teammate/doRules';

/** state, leave (play the closing motion; the window hides after it): main → page. action, size: page → main. */
export const TEAMMATE_CH = { state: 'mate:state', leave: 'mate:leave', action: 'mate:action', size: 'mate:size' } as const;

/** How a bubble or card leaves: the quick close, or the slow fade of a stale signal. */
export type MateLeave = 'fast' | 'stale';

export type MateView = 'bubble' | 'card' | 'history' | 'words' | 'consent';

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
}

export interface CardState {
  view: 'card';
  lang: Lang;
  tag: PingTag;
  title: string;
  /** An answer's `line` is the bubble's line, shown above its Markdown; an ask's `markdown` is the user's words. */
  entries: { kind: 'ask' | 'answer'; label: string; markdown: string; line?: string }[];
  streaming: boolean;
  footer: { profile: string; model: string; tokens: number | null; used: string[] };
}

/** One thread in the History window's list. */
export interface HistoryThread {
  id: string;
  title: string;
  lastActivity: number;
  app: string;
  intents: PingId[];
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
}

/** "Paste this into Chrome?": the teammate asks before it acts. The window never takes the keyboard. */
export interface ConsentState {
  view: 'consent';
  lang: Lang;
  tag: PingTag;
  action: PutAction;
  /** The question, already worded for the action ("Paste your reply into Chrome?"). */
  text: string;
  /** What will be pasted (its first 200 characters), the URL, or the event's title and time. */
  detail: string;
  /** Offer Always allow. */
  always: boolean;
  /** The countdown bar's total length; ending it is the caller's job, the page only draws it. */
  seconds: number;
  /** Which side of the spot the card is on, so it slides in from there. Set by the window; the right when absent. */
  side?: 'left' | 'right';
}

export type MateState = BubbleState | CardState | WordsState | HistoryState | ConsentState;

/** What the consent card sends. */
export type ConsentAction = { t: 'allow' } | { t: 'always' } | { t: 'decline' };

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
  | { t: 'search'; query: string }
  | ConsentAction;

export interface MateApi {
  /** Calls `cb` with every state the main process sends; returns the way to stop. */
  on(cb: (state: MateState) => void): () => void;
  /** Calls `cb` when the window is about to hide; returns the way to stop. */
  onLeave(cb: (how: MateLeave) => void): () => void;
  act(action: MateAction): void;
  /** The page's content size in DIPs, so a transparent window doesn't cover more of the screen than it draws. */
  size(size: { width: number; height: number }): void;
}

/** Longest words the user may type for an ask or a reply. */
export const MATE_TEXT_MAX = 2000;
/** A card's whole text can be copied; anything longer than this is not a real answer. */
export const MATE_COPY_MAX = 100_000;
const URL_MAX = 2048;
const QUERY_MAX = 200;
/** The same rule as HistoryStore uses before an id reaches a file name. */
const THREAD_ID_RE = /^[A-Za-z0-9-]{1,64}$/;

/** What each window may ask for: the words box asks, the card replies, the bubble opens or closes, consent decides. */
const ALLOWED: Record<MateView, ReadonlySet<MateAction['t']>> = {
  bubble: new Set(['more', 'dismiss']),
  card: new Set(['close', 'copy', 'reply', 'deep', 'history', 'link']),
  words: new Set(['ask', 'cancel']),
  history: new Set(['open', 'continue', 'delete', 'search']),
  consent: new Set(['allow', 'always', 'decline']),
};

/** Size limits in DIPs for the windows that fit their content. */
const SIZE_LIMITS: Partial<Record<MateView, { minW: number; maxW: number; minH: number; maxH: number }>> = {
  bubble: { minW: 160, maxW: 440, minH: 40, maxH: 220 },
  card: { minW: 200, maxW: 480, minH: 60, maxH: 600 },
  consent: { minW: 200, maxW: 480, minH: 60, maxH: 400 },
};

const words = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '' && v.length <= MATE_TEXT_MAX;
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
    case 'cancel':
    case 'allow':
    case 'always':
    case 'decline':
      return { t: a.t };
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
      return threadId(a.id) ? { t: a.t, id: a.id } : null;
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
  return action && ALLOWED[view].has(action.t) ? action : null;
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

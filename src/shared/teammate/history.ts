import type { PingId } from '../pings';
import { MAX_SPOTS } from './spots';

/** One thread as stored: its asks and answers, with a 512 px thumbnail of each ask's screen. */
export interface ThreadRecord {
  id: string;
  title: string;
  started: number;
  lastActivity: number;
  app: string;
  windowTitle: string;
  profile: string;
  /** The agent session the thread's answers came from, and the folder it ran in: dsh resumes only there. */
  agent?: { profileId: string; session: string; cwd: string };
  entries: {
    at: number;
    intent: PingId;
    words: string | null;
    line: string;
    markdown: string;
    /** base64 JPEG, 512 px */
    thumb: string;
    /** What the teammate did for the ask, described ("Pasted 2 lines into Chrome"); never the text it put anywhere. */
    done?: string[];
    /** How many spots the ask was about. */
    spots: number;
  }[];
}

const DAY_MS = 86_400_000;

/** A session id an agent printed, safe to pass back to it on a command line. */
export const isSessionId = (v: unknown): v is string => typeof v === 'string' && /^[\w.:-]{1,200}$/.test(v);

/** An entry's spot count as stored: entries written before several spots per ask have none, which is one. */
export const spotCount = (v: unknown): number => (
  typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= MAX_SPOTS ? v : 1
);

/** Ids to delete: threads older than keepDays (null keeps any age), then the oldest beyond maxThreads. */
export function prune(
  index: readonly { id: string; lastActivity: number }[],
  now: number,
  rule: { keepDays: number | null; maxThreads: number },
): string[] {
  const doomed: string[] = [];
  const kept: { id: string; lastActivity: number }[] = [];
  for (const t of index) {
    if (rule.keepDays !== null && now - t.lastActivity > rule.keepDays * DAY_MS) doomed.push(t.id);
    else kept.push(t);
  }
  kept.sort((a, b) => b.lastActivity - a.lastActivity);
  for (const t of kept.slice(Math.max(0, rule.maxThreads))) doomed.push(t.id);
  return doomed;
}

import type { PingId } from '../pings';

/** One thread as stored: its asks and answers, with a 512 px thumbnail of each ask's screen. */
export interface ThreadRecord {
  id: string;
  title: string;
  started: number;
  lastActivity: number;
  app: string;
  windowTitle: string;
  profile: string;
  entries: {
    at: number;
    intent: PingId;
    words: string | null;
    line: string;
    markdown: string;
    /** base64 JPEG, 512 px */
    thumb: string;
  }[];
}

const DAY_MS = 86_400_000;

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

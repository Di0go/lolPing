import type { PingId } from '../pings';

export interface ThreadRef {
  id: string;
  title: string;
  lastActivity: number;
}

const WORDS_WINDOW_MS = 300_000;

/** Whether an ask goes into the current thread or opens a new one. */
export function threadAction(
  intent: PingId,
  current: ThreadRef | null,
  opts: { onTeammate: boolean; newThread?: boolean },
): 'new' | 'continue' {
  if (!current) return 'new';
  if (intent === 'push' || opts.onTeammate) return 'continue';
  if (intent === 'generic') return opts.newThread ? 'new' : 'continue';
  return 'new';
}

/** The words box starts on "continue" when the thread had activity in the last five minutes. */
export function wordsContinuesByDefault(current: ThreadRef | null, now: number): boolean {
  return current !== null && now - current.lastActivity <= WORDS_WINDOW_MS;
}

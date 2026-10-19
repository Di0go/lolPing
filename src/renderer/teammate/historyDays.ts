import type { HistoryThread } from '../../shared/teammateIpc';

/** 'today', 'yesterday', or the local midnight that starts an older day. */
export type Day = 'today' | 'yesterday' | number;

const midnight = (t: number): number => {
  const d = new Date(t);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
};

/** Threads grouped by the local day of their last activity, newest day and newest thread first. */
export function groupByDay(threads: readonly HistoryThread[], now: number): { day: Day; threads: HistoryThread[] }[] {
  const today = midnight(now);
  const yesterday = midnight(today - 1);
  const groups = new Map<number, HistoryThread[]>();
  for (const t of [...threads].sort((a, b) => b.lastActivity - a.lastActivity)) {
    const key = midnight(t.lastActivity);
    const list = groups.get(key);
    if (list) list.push(t);
    else groups.set(key, [t]);
  }
  return [...groups].map(([key, list]) => ({
    day: key === today ? 'today' : key === yesterday ? 'yesterday' : key,
    threads: list,
  }));
}

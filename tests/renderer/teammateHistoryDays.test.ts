import { describe, expect, it } from 'vitest';
import { groupByDay } from '../../src/renderer/teammate/historyDays';

const at = (y: number, m: number, d: number, hh = 12): number => new Date(y, m - 1, d, hh).getTime();
const thread = (id: string, lastActivity: number) => ({ id, title: id, lastActivity, app: 'Code', intents: [] });

describe('groupByDay', () => {
  it('groups threads by local day, newest first, and names today and yesterday', () => {
    const now = at(2026, 10, 19, 15);
    const groups = groupByDay(
      [thread('a', at(2026, 10, 17)), thread('b', at(2026, 10, 19, 1)), thread('c', at(2026, 10, 18, 23)), thread('d', at(2026, 10, 19, 14))],
      now,
    );
    expect(groups.map((g) => [g.day, g.threads.map((t) => t.id)])).toEqual([
      ['today', ['d', 'b']],
      ['yesterday', ['c']],
      [at(2026, 10, 17, 0), ['a']],
    ]);
  });
});

import { describe, expect, it } from 'vitest';
import { prune } from '../../../src/shared/teammate/history';

const DAY = 86_400_000;
const NOW = 100 * DAY;

describe('prune', () => {
  it('prunes by age and by count', () => {
    const index = [
      { id: 'old', lastActivity: NOW - 31 * DAY },
      { id: 'a', lastActivity: NOW - 1 * DAY },
      { id: 'b', lastActivity: NOW - 2 * DAY },
      { id: 'c', lastActivity: NOW - 3 * DAY },
    ];
    expect(prune(index, NOW, { keepDays: 30, maxThreads: 2 }).sort()).toEqual(['c', 'old']);
  });

  it('keeps everything with keepDays null under the count', () => {
    const index = [
      { id: 'ancient', lastActivity: 0 },
      { id: 'a', lastActivity: NOW },
    ];
    expect(prune(index, NOW, { keepDays: null, maxThreads: 5 })).toEqual([]);
    expect(prune(index, NOW, { keepDays: null, maxThreads: 1 })).toEqual(['ancient']);
  });
});

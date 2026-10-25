import { describe, expect, it } from 'vitest';
import { prune, spotCount } from '../../../src/shared/teammate/history';

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

describe('spotCount', () => {
  it('reads an ask without a spot count as one spot', () => {
    expect(spotCount(undefined)).toBe(1);
    expect(spotCount(3)).toBe(3);
    // Anything an ask can't have been made with reads as one spot too.
    for (const bad of [0, 5, 2.5, '3', null]) expect(spotCount(bad)).toBe(1);
  });
});

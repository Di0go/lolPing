import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDLE_MS, IdleWatch } from '../../src/renderer/overlay/idleWatch';

let empty: boolean;
let reports: boolean[];
let watch: IdleWatch;

beforeEach(() => {
  vi.useFakeTimers();
  empty = true;
  reports = [];
  watch = new IdleWatch(() => empty, (idle) => reports.push(idle));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('IdleWatch', () => {
  it('says idle once the overlay has been empty for IDLE_MS', () => {
    watch.check();
    vi.advanceTimersByTime(IDLE_MS - 1);
    expect(reports).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(reports).toEqual([true]);
  });

  it('says busy as soon as something shows after it said idle, and idle again once that is gone', () => {
    watch.check();
    vi.advanceTimersByTime(IDLE_MS);
    empty = false;
    watch.check();
    expect(reports).toEqual([true, false]);
    empty = true;
    watch.check();
    vi.advanceTimersByTime(IDLE_MS);
    expect(reports).toEqual([true, false, true]);
  });

  it('waits a full IDLE_MS after the last thing on screen went, so a closing wheel can fade out', () => {
    watch.check();
    vi.advanceTimersByTime(IDLE_MS - 50);
    empty = false;
    watch.check(); // a ping came and went before the overlay was ever reported idle
    empty = true;
    watch.check();
    vi.advanceTimersByTime(IDLE_MS - 1);
    expect(reports).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(reports).toEqual([true]);
  });

  it('reports each change once, however often it is checked', () => {
    for (let i = 0; i < 3; i++) watch.check();
    vi.advanceTimersByTime(IDLE_MS * 3);
    for (let i = 0; i < 3; i++) watch.check();
    vi.advanceTimersByTime(IDLE_MS * 3);
    empty = false;
    for (let i = 0; i < 3; i++) watch.check();
    expect(reports).toEqual([true, false]);
  });

  it('says nothing while the overlay has something on it from the start', () => {
    empty = false;
    watch.check();
    vi.advanceTimersByTime(IDLE_MS * 10);
    expect(reports).toEqual([]);
  });
});

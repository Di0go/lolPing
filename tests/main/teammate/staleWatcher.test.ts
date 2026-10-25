import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StaleWatcher } from '../../../src/main/teammate/staleWatcher';
import { FRONT_POLL_MS, type FrontWindow } from '../../../src/shared/teammate/stale';

const OWN = 900;
const page: FrontWindow = { window: '263544', title: 'Docs - Chrome', box: { x: 100, y: 50, w: 1200, h: 900 }, pid: 4242 };
/** Where the card sits over the page, in helper coordinates. */
const CARD = { x: 1000, y: 100, w: 300, h: 300 };

function harness(opts: { front?: () => Promise<FrontWindow> } = {}) {
  const helper: boolean[] = [];
  let busy = false;
  let stale = 0;
  let polls = 0;
  let answer: () => Promise<FrontWindow> = opts.front ?? (async () => page);
  const watcher = new StaleWatcher({
    front: () => {
      polls += 1;
      return answer();
    },
    busy: () => busy,
    ownPid: OWN,
    helper: (on) => helper.push(on),
    own: (at) => at.x >= CARD.x && at.x < CARD.x + CARD.w && at.y >= CARD.y && at.y < CARD.y + CARD.h,
    stale: () => {
      stale += 1;
    },
    every: (ms, fn) => {
      const timer = setInterval(fn, ms);
      return () => clearInterval(timer);
    },
  });
  return {
    watcher, helper,
    polls: () => polls,
    stale: () => stale,
    setBusy: (on: boolean) => {
      busy = on;
    },
    answer: (fn: () => Promise<FrontWindow>) => {
      answer = fn;
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('StaleWatcher', () => {
  it('turns the helper\'s watch on and off', async () => {
    const h = harness();
    h.watcher.start(page.window);
    expect(h.helper).toEqual([true]);
    await vi.advanceTimersByTimeAsync(FRONT_POLL_MS * 3);
    const polled = h.polls();
    expect(polled).toBeGreaterThanOrEqual(3);
    h.watcher.stop();
    expect(h.helper).toEqual([true, false]);
    await vi.advanceTimersByTimeAsync(FRONT_POLL_MS * 3);
    expect(h.polls()).toBe(polled);
    h.watcher.stop(); // already off: nothing more is sent
    h.watcher.scroll({ x: 600, y: 400 });
    expect(h.helper).toEqual([true, false]);
    expect(h.stale()).toBe(0);
  });

  it('skips a poll while the context helper has a request waiting', async () => {
    const h = harness();
    h.setBusy(true); // a paste or a slow read: a poll now would wait behind it and could time out
    h.watcher.start(page.window);
    await vi.advanceTimersByTimeAsync(FRONT_POLL_MS * 10);
    expect(h.polls()).toBe(0);
    h.setBusy(false);
    await vi.advanceTimersByTimeAsync(FRONT_POLL_MS);
    expect(h.polls()).toBe(1);
  });

  it('sends no second poll while one is out', async () => {
    let reply: (f: FrontWindow) => void = () => undefined;
    const h = harness({ front: () => new Promise((resolve) => { reply = resolve; }) });
    h.watcher.start(page.window);
    await vi.advanceTimersByTimeAsync(FRONT_POLL_MS * 4);
    const out = h.polls();
    expect(out).toBe(1);
    reply(page);
    await vi.advanceTimersByTimeAsync(FRONT_POLL_MS);
    expect(h.polls()).toBe(out + 1);
  });

  it('tells the controller once and stops', async () => {
    const h = harness();
    h.watcher.start(page.window);
    await vi.advanceTimersByTimeAsync(FRONT_POLL_MS);
    h.watcher.scroll({ x: 1100, y: 200 }); // the card's own text
    h.watcher.scroll({ x: 1500, y: 200 }); // another window
    expect(h.stale()).toBe(0);
    h.watcher.scroll({ x: 600, y: 400 }); // the page
    h.watcher.scroll({ x: 600, y: 420 });
    expect(h.stale()).toBe(1);
    expect(h.helper).toEqual([true, false]);
    const polled = h.polls();
    await vi.advanceTimersByTimeAsync(FRONT_POLL_MS * 3);
    expect(h.polls()).toBe(polled);
  });

  it('goes stale when a poll finds the window moved', async () => {
    const h = harness();
    h.watcher.start(page.window);
    await vi.advanceTimersByTimeAsync(FRONT_POLL_MS);
    h.answer(async () => ({ ...page, box: { ...page.box, y: 300 } }));
    await vi.advanceTimersByTimeAsync(FRONT_POLL_MS);
    expect(h.stale()).toBe(1);
    expect(h.helper).toEqual([true, false]);
  });

  it('keeps watching scrolls when the poll fails', async () => {
    const h = harness({ front: async () => Promise.reject(new Error('bad')) });
    h.watcher.start(page.window);
    await vi.advanceTimersByTimeAsync(FRONT_POLL_MS * 3);
    expect(h.stale()).toBe(0);
    expect(h.polls()).toBeGreaterThanOrEqual(3);
    h.watcher.scroll({ x: 600, y: 400 });
    expect(h.stale()).toBe(1);
  });

  it('starts again from a new baseline for a new window', async () => {
    const h = harness();
    h.watcher.start(page.window);
    await vi.advanceTimersByTimeAsync(FRONT_POLL_MS);
    const other: FrontWindow = { ...page, window: '5150', title: 'Slack', box: { x: 1400, y: 0, w: 500, h: 900 } };
    h.answer(async () => other);
    h.watcher.start(other.window);
    await vi.advanceTimersByTimeAsync(FRONT_POLL_MS * 2);
    expect(h.stale()).toBe(0);
    h.watcher.scroll({ x: 600, y: 400 }); // the old window is no longer the one asked about
    expect(h.stale()).toBe(0);
    h.watcher.scroll({ x: 1500, y: 400 });
    expect(h.stale()).toBe(1);
  });

  it('drops a poll answered after the watch stopped', async () => {
    let reply: (f: FrontWindow) => void = () => undefined;
    const h = harness({ front: () => new Promise((resolve) => { reply = resolve; }) });
    h.watcher.start(page.window);
    await vi.advanceTimersByTimeAsync(FRONT_POLL_MS);
    h.watcher.stop();
    reply({ ...page, window: '5150' });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.stale()).toBe(0);
  });

  it('turns the helper\'s watch on again after a restart', () => {
    const h = harness();
    h.watcher.helperReady(); // not watching: the helper's watch stays off
    expect(h.helper).toEqual([]);
    h.watcher.start(page.window);
    h.watcher.helperReady();
    expect(h.helper).toEqual([true, true]);
    h.watcher.stop();
    h.watcher.helperReady();
    expect(h.helper).toEqual([true, true, false]);
  });
});

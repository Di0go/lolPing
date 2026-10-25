import { describe, expect, it } from 'vitest';
import { StaleRule, type FrontWindow } from '../../../src/shared/teammate/stale';

const OWN = 900;
const page: FrontWindow = { window: '263544', title: 'Docs - Chrome', box: { x: 100, y: 50, w: 1200, h: 900 }, pid: 4242 };
const settings: FrontWindow = { window: '777', title: 'lolPing Settings', box: { x: 0, y: 0, w: 800, h: 600 }, pid: OWN };

const rule = (askWindow = page.window): StaleRule => new StaleRule({ askWindow, ownPid: OWN });

describe('StaleRule', () => {
  it('goes stale when the ask\'s window scrolls', () => {
    const r = rule();
    expect(r.front(page)).toBe(false);
    expect(r.scroll({ x: 600, y: 400 }, false)).toBe(true);
  });

  it('ignores a scroll over lolPing\'s own windows', () => {
    const r = rule();
    r.front(page);
    // The card sits over the page: scrolling its text is reading it.
    expect(r.scroll({ x: 600, y: 400 }, true)).toBe(false);
    // Before the first poll too.
    expect(rule().scroll({ x: 600, y: 400 }, true)).toBe(false);
  });

  it('ignores a scroll over another window', () => {
    const r = rule();
    r.front(page);
    expect(r.scroll({ x: 1500, y: 400 }, false)).toBe(false);
    expect(r.scroll({ x: 600, y: 960 }, false)).toBe(false);
  });

  it('counts any scroll that is not over lolPing before the first poll answers', () => {
    expect(rule().scroll({ x: 1500, y: 400 }, false)).toBe(true);
  });

  it('goes stale when the window moves, resizes or changes title', () => {
    const changed: FrontWindow[] = [
      { ...page, box: { ...page.box, x: 103 } },
      { ...page, box: { ...page.box, y: 47 } },
      { ...page, box: { ...page.box, w: 1203 } },
      { ...page, box: { ...page.box, h: 897 } },
      { ...page, title: 'Other tab - Chrome' },
    ];
    for (const f of changed) {
      const r = rule();
      r.front(page);
      expect(r.front(f)).toBe(true);
    }
  });

  it('ignores a 1 px jitter', () => {
    const r = rule();
    r.front(page);
    expect(r.front({ ...page, box: { x: 101, y: 49, w: 1199, h: 902 } })).toBe(false);
    expect(r.front(page)).toBe(false);
  });

  it('goes stale when another app comes to the front', () => {
    const r = rule();
    r.front(page);
    expect(r.front({ ...page, window: '5150', title: 'Slack', pid: 77 })).toBe(true);
    // The user had already left the ask's window when the first poll came.
    expect(rule().front({ ...page, window: '5150' })).toBe(true);
  });

  it('takes whatever is in front as the baseline for an agent\'s marks', () => {
    const r = rule('');
    expect(r.front(page)).toBe(false);
    expect(r.front({ ...page, window: '5150' })).toBe(true);
  });

  it('an ask made from lolPing\'s own window takes its baseline from the next window in front', () => {
    // Asked from the card's reply box: no ask window, and lolPing's own polls don't set the baseline.
    const r = rule('');
    expect(r.front(settings)).toBe(false);
    expect(r.front(page)).toBe(false);
    expect(r.front(page)).toBe(false);
    expect(r.front({ ...page, title: 'Other tab - Chrome' })).toBe(true);
  });

  it('ignores lolPing\'s own window in front', () => {
    const r = rule();
    r.front(page);
    expect(r.front(settings)).toBe(false);
    expect(r.front(page)).toBe(false);
    // Before the baseline: lolPing in front is not the baseline either.
    const early = rule();
    expect(early.front(settings)).toBe(false);
    expect(early.front(page)).toBe(false);
    expect(early.scroll({ x: 1500, y: 400 }, false)).toBe(false);
  });
});

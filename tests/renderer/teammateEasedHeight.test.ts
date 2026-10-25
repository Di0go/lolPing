import { describe, expect, it } from 'vitest';
import { contentHeight, EASE_MS, heightStep } from '../../src/renderer/teammate/easedHeight';

describe('heightStep', () => {
  it('grows the window at once and shrinks it after the ease', () => {
    expect(heightStep(200, 360, false)).toEqual({ window: 360, settleMs: 0 });
    expect(heightStep(360, 200, false)).toEqual({ window: 360, settleMs: EASE_MS });
  });

  it('leaves the window alone when the height is unchanged', () => {
    expect(heightStep(300, 300, false)).toEqual({ window: 300, settleMs: 0 });
  });

  it('follows at once with reduced motion', () => {
    expect(heightStep(200, 360, true)).toEqual({ window: 360, settleMs: 0 });
    expect(heightStep(360, 200, true)).toEqual({ window: 200, settleMs: 0 });
  });
});

describe('contentHeight', () => {
  it('adds the room round the children and the gaps between them', () => {
    expect(contentHeight(20, 8, [30, 100, 20], 576)).toBe(20 + 16 + 150);
  });

  it('gives a smaller height for shorter content', () => {
    expect(contentHeight(20, 8, [30, 40, 20], 576)).toBeLessThan(contentHeight(20, 8, [30, 100, 20], 576));
  });

  it('stops at the maximum', () => {
    expect(contentHeight(20, 8, [30, 900, 20], 576)).toBe(576);
  });

  it('is just the room round it with no children', () => {
    expect(contentHeight(20, 8, [], 576)).toBe(20);
  });
});

import { describe, expect, it } from 'vitest';
import { EASE_MS, heightStep } from '../../src/renderer/teammate/easedHeight';

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

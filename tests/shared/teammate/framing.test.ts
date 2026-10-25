import { describe, expect, it } from 'vitest';
import { frameAsk, frameSpots } from '../../../src/shared/teammate/framing';

const DISPLAY = { x: 0, y: 0, w: 2752, h: 1152 };
const SPOT = { x: 700, y: 400 };
// A word in a paragraph, the article, the page's scroll area and a 1400 x 1000 window.
const WORD = { x: 680, y: 390, w: 60, h: 20 };
const PARAGRAPH = { x: 300, y: 380, w: 900, h: 60 };
const ARTICLE = { x: 280, y: 200, w: 940, h: 400 };
const PAGE = { x: 100, y: 100, w: 1300, h: 900 };
const WINDOW = { x: 92, y: 40, w: 1400, h: 1000 };
const CHAIN = [WORD, PARAGRAPH, ARTICLE, PAGE, WINDOW];

describe('frameAsk', () => {
  it('shows the window and the smallest block that holds the spot with room around it', () => {
    expect(frameAsk('missing', CHAIN, DISPLAY, SPOT)).toEqual({
      area: WINDOW,
      // The word and the one-line paragraph are too small; the article is the first block big enough.
      crop: { x: 264, y: 184, w: 972, h: 432 },
    });
  });

  it('gives Show me how and Whole picture the panel around the spot', () => {
    const wide = { area: WINDOW, crop: { x: 84, y: 84, w: 1332, h: 932 } };
    expect(frameAsk('assist', CHAIN, DISPLAY, SPOT)).toEqual(wide);
    expect(frameAsk('allin', CHAIN, DISPLAY, SPOT)).toEqual(wide);
  });

  it('cuts a block larger than the close-up to the part around the spot', () => {
    const maximized = { x: -8, y: -8, w: 2768, h: 1168 };
    const framing = frameAsk('missing', [WORD, maximized], DISPLAY, SPOT);
    // The window spills past the display edges and is cut to them.
    expect(framing.area).toEqual(DISPLAY);
    expect(framing.crop).toEqual({ x: 0, y: 0, w: 1600, h: 1000 });
  });

  it('shows the whole display around a small window such as a menu', () => {
    const menu = { x: 650, y: 350, w: 300, h: 400 };
    const framing = frameAsk('missing', [WORD, menu], DISPLAY, SPOT);
    expect(framing.area).toEqual(DISPLAY);
    expect(framing.crop).toEqual({ x: 0, y: 0, w: 1600, h: 1000 });
  });

  it('ignores boxes that do not hold the spot', () => {
    const scrolledAway = { x: 2000, y: 0, w: 600, h: 600 };
    expect(frameAsk('missing', [scrolledAway, ARTICLE, WINDOW], DISPLAY, SPOT).crop)
      .toEqual({ x: 264, y: 184, w: 972, h: 432 });
  });

  it('falls back to the display and a fixed crop without boxes', () => {
    expect(frameAsk('missing', [], DISPLAY, SPOT)).toEqual({
      area: DISPLAY, crop: { x: 200, y: 25, w: 1000, h: 750 },
    });
  });
});

describe('frameSpots', () => {
  // Two 1000 x 900 windows side by side, a spot in each.
  const LEFT = { x: 0, y: 40, w: 1000, h: 900 };
  const RIGHT = { x: 1000, y: 40, w: 1000, h: 900 };
  const LEFT_SPOT = { x: 300, y: 400 };
  const RIGHT_SPOT = { x: 1700, y: 400 };

  it('frames one spot as frameAsk does', () => {
    const one = frameAsk('missing', CHAIN, DISPLAY, SPOT);
    expect(frameSpots('missing', [CHAIN], DISPLAY, [SPOT])).toEqual({ area: one.area, crops: [one.crop] });
  });

  it('holds every spot in the overview and gives each its own close-up', () => {
    const framing = frameSpots('missing', [[LEFT], [RIGHT]], DISPLAY, [LEFT_SPOT, RIGHT_SPOT]);
    expect(framing.area).toEqual({ x: 0, y: 40, w: 2000, h: 900 });
    expect(framing.crops).toEqual([
      frameAsk('missing', [LEFT], DISPLAY, LEFT_SPOT).crop,
      frameAsk('missing', [RIGHT], DISPLAY, RIGHT_SPOT).crop,
    ]);
  });

  it('keeps each close-up inside the display', () => {
    const edge = { x: 20, y: 20 };
    const far = { x: DISPLAY.w - 20, y: DISPLAY.h - 20 };
    const framing = frameSpots('missing', [[], []], DISPLAY, [edge, far]);
    for (const c of framing.crops) {
      expect(c.x).toBeGreaterThanOrEqual(0);
      expect(c.y).toBeGreaterThanOrEqual(0);
      expect(c.x + c.w).toBeLessThanOrEqual(DISPLAY.w);
      expect(c.y + c.h).toBeLessThanOrEqual(DISPLAY.h);
    }
    expect(framing.area).toEqual(DISPLAY);
  });
});

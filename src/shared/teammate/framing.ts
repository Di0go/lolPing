import type { Point } from '../ipc';
import type { PingId } from '../pings';
import { zoomRect, type Rect } from './coords';

/** A smaller window (a menu, a tooltip) says too little on its own: the overview shows the display instead. */
const MIN_WINDOW = { w: 640, h: 400 };
/** The smallest close-up: the block the spot is in, such as a paragraph, a table or a message, not the word alone. */
const MIN_BLOCK = { w: 480, h: 240 };
/** Show me how and Whole picture want the dialog or panel around the spot. */
const MIN_PANEL = { w: 800, h: 480 };
/** The largest close-up; a larger block gives this much of itself around the spot. */
const MAX_CLOSE = { w: 1600, h: 1000 };
/** Room around the block so its edges show. */
const MARGIN = 16;

/** What one ask's capture shows: the overview's area and the spot's close-up, both in physical pixels. */
export interface Framing {
  area: Rect;
  crop: Rect;
}

function intersect(a: Rect, b: Rect): Rect | null {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.w, b.x + b.w);
  const bottom = Math.min(a.y + a.h, b.y + b.h);
  return right > x && bottom > y ? { x, y, w: right - x, h: bottom - y } : null;
}

const holds = (r: Rect, p: Point): boolean => p.x >= r.x && p.y >= r.y && p.x < r.x + r.w && p.y < r.y + r.h;
const atLeast = (r: Rect, min: { w: number; h: number }): boolean => r.w >= min.w && r.h >= min.h;

/**
 * Frames an ask from the boxes around the element under its spot (innermost first, ending with the window): the
 * overview shows that window, and the close-up is the smallest box big enough for the task, cut to MAX_CLOSE around
 * the spot. Without boxes (no accessibility, a game) it is the whole display and a fixed crop around the spot.
 */
export function frameAsk(task: PingId, chain: readonly Rect[], display: Rect, spot: Point): Framing {
  // A box that scrolled past the display or doesn't hold the spot frames nothing.
  const boxes = chain.flatMap((b) => {
    const seen = intersect(b, display);
    return seen && holds(seen, spot) ? [seen] : [];
  });
  const window = boxes.at(-1);
  if (!window) return { area: display, crop: zoomRect(display, spot) };
  const area = atLeast(window, MIN_WINDOW) ? window : display;
  const min = task === 'assist' || task === 'allin' ? MIN_PANEL : MIN_BLOCK;
  const block = boxes.find((b) => atLeast(b, min)) ?? area;
  const grown = { x: block.x - MARGIN, y: block.y - MARGIN, w: block.w + 2 * MARGIN, h: block.h + 2 * MARGIN };
  const padded = intersect(grown, display) ?? block;
  return { area, crop: zoomRect(padded, spot, MAX_CLOSE) };
}

/**
 * Frames each spot alone with its own chain, as frameAsk does; the overview area is the smallest rect holding every
 * spot's area, so one picture shows them all.
 */
export function frameSpots(
  task: PingId,
  chains: readonly (readonly Rect[])[],
  display: Rect,
  spots: readonly Point[],
): { area: Rect; crops: Rect[] } {
  const framed = spots.map((spot, i) => frameAsk(task, chains[i] ?? [], display, spot));
  const left = Math.min(...framed.map((f) => f.area.x));
  const top = Math.min(...framed.map((f) => f.area.y));
  const right = Math.max(...framed.map((f) => f.area.x + f.area.w));
  const bottom = Math.max(...framed.map((f) => f.area.y + f.area.h));
  const area = intersect({ x: left, y: top, w: right - left, h: bottom - top }, display) ?? display;
  return { area, crops: framed.map((f) => f.crop) };
}

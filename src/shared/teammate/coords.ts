export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** One ask's capture: the screen area the overview shows (physical px), its size, and the close-ups (physical px). */
export interface Shot {
  area: Rect;
  overview: { w: number; h: number };
  zooms: Rect[];
}

const RECEIPT_OFFSET = 40;
const RECEIPT_MARGIN = 30;

const clamp = (v: number, min: number, max: number): number => Math.max(min, Math.min(v, max));

/** An overview-image point → physical screen pixels; null when it lies outside the image. */
export function overviewToPhysical(shot: Shot, p: { x: number; y: number }): { x: number; y: number } | null {
  const { area, overview } = shot;
  if (overview.w <= 0 || overview.h <= 0) return null;
  if (p.x < 0 || p.y < 0 || p.x >= overview.w || p.y >= overview.h) return null;
  return {
    x: Math.round(area.x + (p.x * area.w) / overview.w),
    y: Math.round(area.y + (p.y * area.h) / overview.h),
  };
}

/** A physical screen point → overview-image pixels, rounded; it may lie outside the image. */
export function physicalToOverview(shot: Shot, p: { x: number; y: number }): { x: number; y: number } {
  const { area, overview } = shot;
  return {
    x: Math.round(((p.x - area.x) * overview.w) / area.w),
    y: Math.round(((p.y - area.y) * overview.h) / area.h),
  };
}

/** A physical screen rectangle → overview-image pixels, each number rounded. */
export function physicalBoxToOverview(shot: Shot, box: Rect): Rect {
  const { area, overview } = shot;
  const sx = overview.w / area.w;
  const sy = overview.h / area.h;
  return {
    x: Math.round((box.x - area.x) * sx),
    y: Math.round((box.y - area.y) * sy),
    w: Math.round(box.w * sx),
    h: Math.round(box.h * sy),
  };
}

/** The crop around `spot` for a zoom, moved (not shrunk) to stay inside the display unless the display is smaller. */
export function zoomRect(
  display: Rect,
  spot: { x: number; y: number },
  size: { w: number; h: number } = { w: 1000, h: 750 },
): Rect {
  const w = Math.min(size.w, display.w);
  const h = Math.min(size.h, display.h);
  return {
    x: Math.round(clamp(spot.x - w / 2, display.x, display.x + display.w - w)),
    y: Math.round(clamp(spot.y - h / 2, display.y, display.y + display.h - h)),
    w,
    h,
  };
}

/** Where the receipt ping goes: 40 px right and up of the spot, kept 30 px inside the display. */
export function receiptPoint(spot: { x: number; y: number }, display: Rect): { x: number; y: number } {
  return {
    x: clamp(spot.x + RECEIPT_OFFSET, display.x + RECEIPT_MARGIN, display.x + display.w - RECEIPT_MARGIN),
    y: clamp(spot.y - RECEIPT_OFFSET, display.y + RECEIPT_MARGIN, display.y + display.h - RECEIPT_MARGIN),
  };
}

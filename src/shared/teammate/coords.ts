/** One ask's capture: the display (physical px), the overview sent to the model, and any zoom crops (physical px). */
export interface Shot {
  display: { x: number; y: number; w: number; h: number };
  overview: { w: number; h: number };
  zooms: { x: number; y: number; w: number; h: number }[];
}

const RECEIPT_OFFSET = 40;
const RECEIPT_MARGIN = 30;

const clamp = (v: number, min: number, max: number): number => Math.max(min, Math.min(v, max));

/** An overview-image point → physical screen pixels; null when it lies outside the image. */
export function overviewToPhysical(shot: Shot, p: { x: number; y: number }): { x: number; y: number } | null {
  const { display, overview } = shot;
  if (overview.w <= 0 || overview.h <= 0) return null;
  if (p.x < 0 || p.y < 0 || p.x >= overview.w || p.y >= overview.h) return null;
  return {
    x: Math.round(display.x + (p.x * display.w) / overview.w),
    y: Math.round(display.y + (p.y * display.h) / overview.h),
  };
}

/** The crop around `spot` for a zoom, moved (not shrunk) to stay inside the display unless the display is smaller. */
export function zoomRect(
  display: Shot['display'],
  spot: { x: number; y: number },
  size: { w: number; h: number } = { w: 1000, h: 750 },
): { x: number; y: number; w: number; h: number } {
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
export function receiptPoint(spot: { x: number; y: number }, display: Shot['display']): { x: number; y: number } {
  return {
    x: clamp(spot.x + RECEIPT_OFFSET, display.x + RECEIPT_MARGIN, display.x + display.w - RECEIPT_MARGIN),
    y: clamp(spot.y - RECEIPT_OFFSET, display.y + RECEIPT_MARGIN, display.y + display.h - RECEIPT_MARGIN),
  };
}

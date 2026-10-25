/** How long the card's height eases (the same as Fluent's durationNormal). */
export const EASE_MS = 200;

/** The attribute the card puts its content's height in, so the window can size to it while the card still eases. */
export const HEIGHT_TARGET = 'data-height-target';

/**
 * How the card's window follows its content: it grows at once, so nothing clips while the card eases open, and
 * shrinks only after the ease. `shown` is the height the window has now, `target` the height the content settles at.
 */
export function heightStep(shown: number, target: number, reduced: boolean): { window: number; settleMs: number } {
  if (reduced) return { window: target, settleMs: 0 };
  return { window: Math.max(shown, target), settleMs: target < shown ? EASE_MS : 0 };
}

/**
 * The height a column of boxes needs, whatever height it is held at now: the room round it (padding and border),
 * its children's own heights and the gaps between them, up to `max`.
 */
export function contentHeight(chrome: number, gap: number, children: readonly number[], max: number): number {
  const gaps = Math.max(children.length - 1, 0) * gap;
  return Math.min(chrome + gaps + children.reduce((sum, h) => sum + h, 0), max);
}

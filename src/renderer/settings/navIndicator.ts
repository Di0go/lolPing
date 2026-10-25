/** One keyframe of the selection bar, in px. A type rather than an interface, so it fits the Web Animations `Keyframe`. */
export type BarFrame = { top: string; height: string; offset?: number };

/**
 * The selection bar's move from one nav item to another, like WinUI's NavigationView: halfway it stretches over the
 * whole gap, then its far end lets go. `from` and `to` are the bar's top in px, `size` its height. No move, no frames.
 */
export function barFrames(from: number, to: number, size: number): BarFrame[] {
  if (from === to) return [];
  const px = (v: number) => `${v}px`;
  return [
    { top: px(from), height: px(size) },
    { top: px(Math.min(from, to)), height: px(Math.abs(to - from) + size), offset: 0.5 },
    { top: px(to), height: px(size) },
  ];
}

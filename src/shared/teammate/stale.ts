import type { Point } from '../ipc';
import type { Rect } from './coords';

/** How often the window in front is read while the teammate's marks are up. */
export const FRONT_POLL_MS = 500;
/** A window edge that moved this far or less is jitter, not a move. */
export const MOVE_TOLERANCE_PX = 2;

/** The window in front: its id (as the foreground reply's), caption, screen box and process id. */
export interface FrontWindow {
  window: string;
  title: string;
  box: Rect;
  pid: number;
}

const moved = (a: Rect, b: Rect): boolean => [
  [a.x, b.x], [a.y, b.y], [a.x + a.w, b.x + b.w], [a.y + a.h, b.y + b.h],
].some(([p, q]) => Math.abs(p - q) > MOVE_TOLERANCE_PX);

const inside = (p: Point, r: Rect): boolean => p.x >= r.x && p.x < r.x + r.w && p.y >= r.y && p.y < r.y + r.h;

/**
 * Decides when the page under the teammate's marks has changed, so the marks no longer point at what they meant: the
 * window in front changed, moved, resized or retitled, or the window the ask was made in scrolled.
 */
export class StaleRule {
  private base: FrontWindow | null = null;

  /** askWindow: the ask's window id ('' for an agent's unprompted marks); ownPid: lolPing's process. */
  constructor(private readonly opts: { askWindow: string; ownPid: number }) {}

  /** One poll: true when the marks went stale. */
  front(f: FrontWindow): boolean {
    // lolPing in front is the card's reply box or Settings: the user is still with the answer.
    if (f.pid === this.opts.ownPid) return false;
    const base = this.base;
    if (!base) {
      this.base = f;
      return this.opts.askWindow !== '' && f.window !== this.opts.askWindow;
    }
    return f.window !== base.window || f.title !== base.title || moved(base.box, f.box);
  }

  /** A scroll at `at` (helper coordinates); `own`: over one of lolPing's windows. */
  scroll(at: Point, own: boolean): boolean {
    if (own) return false; // scrolling the card is reading it
    // Before the first poll it can't tell which window is the ask's.
    return this.base === null || inside(at, this.base.box);
  }
}

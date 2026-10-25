import type { Spot } from './askMachine';

export const MAX_SPOTS = 4;
/** A key-up the helper never reported (focus stolen, a lost event): the spots go this long after the last release. */
export const LOST_KEY_UP_MS = 3000;

export type AddResult =
  | { t: 'send'; spots: Spot[] }
  | { t: 'wait'; dueAt: number }
  | { t: 'refused'; why: 'full' | 'display' };

/** Gathers up to MAX_SPOTS releases of one ask; time is passed in and `due` is polled, so it holds no timer. */
export class SpotCollector {
  private spots: Spot[] = [];
  private lastAddAt = 0;

  constructor(private readonly now: () => number) {}

  /** `held`: the ask key is a keyboard key (the helper reports its up). */
  add(spot: Spot, held: boolean): AddResult {
    // A mouse button has no up we can wait for, so each release is its own ask.
    if (!held) return { t: 'send', spots: [spot] };
    if (this.spots.length >= MAX_SPOTS) return { t: 'refused', why: 'full' };
    // One capture covers one display.
    if (this.spots.length > 0 && this.spots[0].displayId !== spot.displayId) return { t: 'refused', why: 'display' };
    this.spots.push(spot);
    this.lastAddAt = this.now();
    return { t: 'wait', dueAt: this.lastAddAt + LOST_KEY_UP_MS };
  }

  /** The ask key came up: the spots to send, or null when none were collected. */
  keyUp(): Spot[] | null {
    const spots = this.take();
    return spots.length > 0 ? spots : null;
  }

  /** The spots to send when the last add was LOST_KEY_UP_MS ago and no key-up came, else null. */
  due(): Spot[] | null {
    if (this.spots.length === 0 || this.now() < this.lastAddAt + LOST_KEY_UP_MS) return null;
    return this.take();
  }

  /** The collected spots, emptied: an ask click opens the words box with them. */
  take(): Spot[] {
    const spots = this.spots;
    this.spots = [];
    return spots;
  }

  clear(): void {
    this.spots = [];
  }

  /** The collected spots, kept. */
  get held(): Spot[] {
    return [...this.spots];
  }

  get size(): number {
    return this.spots.length;
  }
}

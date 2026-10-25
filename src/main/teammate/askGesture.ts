import type { Spot } from '../../shared/teammate/askMachine';
import { SpotCollector } from '../../shared/teammate/spots';

export interface AskGestureDeps {
  now: () => number;
  /** Calls `fn` after `ms`; returns a cancel. */
  timer: (ms: number, fn: () => void) => () => void;
  /** The ask key (or the ping key in same-key mode) is a keyboard key. */
  held: () => boolean;
  ask: (spots: Spot[]) => void;
  /** Opens the words box at the last spot; the ask goes with every spot when the words are sent. */
  words: (spots: Spot[]) => void;
  /** A short line at the spot: 'full' or 'display'. */
  note: (spot: Spot, why: 'full' | 'display') => void;
  /** Reads the screen for the held spots so far, in place of the read before; the ask on the same spots takes it. */
  prepare: (spots: Spot[]) => void;
  /** Drops that read. */
  drop: () => void;
}

/**
 * Turns ask-wheel releases into asks: while a keyboard ask key is held each release adds a spot, and the ask goes with
 * all of them when the key comes up, or LOST_KEY_UP_MS after the last release when its up never comes. Each held
 * release reads the screen ahead, so the key-up only sends.
 */
export class AskGesture {
  private readonly spots: SpotCollector;
  private stopTimer: (() => void) | null = null;

  constructor(private readonly deps: AskGestureDeps) {
    this.spots = new SpotCollector(deps.now);
  }

  /** An ask-wheel release on an enabled intent. */
  release(spot: Spot): void {
    const r = this.spots.add(spot, this.deps.held());
    if (r.t === 'send') return this.deps.ask(r.spots);
    if (r.t === 'refused') return this.deps.note(spot, r.why);
    this.disarm();
    // Armed for the last release: due when it fires, even if now() still reads a few ms short (libuv's clock).
    this.stopTimer = this.deps.timer(r.dueAt - this.deps.now(), () => {
      this.stopTimer = null;
      const spots = this.spots.take();
      if (spots.length > 0) this.deps.ask(spots);
    });
    this.deps.prepare(this.spots.held);
  }

  /**
   * An ask click, or a double tap at the pointer (intent 'generic'): the words box opens with the held spots. A click
   * whose own spot is refused (four held, another screen) still opens it, with the held spots alone.
   */
  click(spot: Spot): void {
    if (this.spots.size > 0) {
      this.deps.drop(); // the words box reads when its words are sent
      const r = this.spots.add(spot, true);
      if (r.t === 'refused') this.deps.note(spot, r.why);
    }
    const spots = this.spots.size > 0 ? this.spots.take() : [spot];
    this.disarm();
    this.deps.words(spots);
  }

  /** The ask key came up (or the ping key in same-key mode). */
  keyUp(): void {
    const spots = this.spots.keyUp();
    this.disarm();
    if (spots) this.deps.ask(spots);
  }

  /** Pause, the helper stopped, or the teammate going down: held spots are dropped. */
  cancel(): void {
    this.spots.clear();
    this.disarm();
    this.deps.drop();
  }

  private disarm(): void {
    this.stopTimer?.();
    this.stopTimer = null;
  }
}

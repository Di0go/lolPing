import type { Point } from '../../shared/ipc';
import { FRONT_POLL_MS, StaleRule, type FrontWindow } from '../../shared/teammate/stale';

export interface StaleWatcherDeps {
  front: (signal: AbortSignal) => Promise<FrontWindow>;
  /** The context helper has a request waiting: a poll now would queue behind it and could time out. */
  busy: () => boolean;
  ownPid: number;
  /** Sends `{ type: 'staleWatch', on }` to the input helper. */
  helper: (on: boolean) => void;
  /** The point (helper coordinates) is over a shown teammate window. */
  own: (at: Point) => boolean;
  stale: () => void;
  every: (ms: number, fn: () => void) => () => void;
}

/**
 * Watches the page under the teammate's marks while they are up: polls the window in front and takes the input
 * helper's scrolls, and tells `stale` once when the page changed.
 */
export class StaleWatcher {
  private rule: StaleRule | null = null;
  private cancelEvery: (() => void) | null = null;
  private poll: AbortController | null = null;

  constructor(private readonly deps: StaleWatcherDeps) {}

  /** Also restarts with a new window, from a new baseline. */
  start(askWindow: string): void {
    this.halt();
    this.rule = new StaleRule({ askWindow, ownPid: this.deps.ownPid });
    this.deps.helper(true);
    this.cancelEvery = this.deps.every(FRONT_POLL_MS, () => this.tick());
    this.tick(); // a baseline at once, so a scroll right after the receipt is judged by it
  }

  stop(): void {
    if (!this.rule) return;
    this.halt();
    this.deps.helper(false);
  }

  scroll(at: Point): void {
    const rule = this.rule;
    if (rule?.scroll(at, this.deps.own(at))) this.fire();
  }

  /** The helper restarted: it forgot the watch. */
  helperReady(): void {
    if (this.rule) this.deps.helper(true);
  }

  private tick(): void {
    const rule = this.rule;
    if (!rule || this.poll || this.deps.busy()) return;
    const poll = new AbortController();
    this.poll = poll;
    this.deps.front(poll.signal).then((f) => {
      if (this.poll !== poll) return; // stopped or restarted meanwhile
      this.poll = null;
      if (rule.front(f)) this.fire();
    }, () => {
      // A failed poll changes nothing (macOS has no front read yet): scrolls still count.
      if (this.poll === poll) this.poll = null;
    });
  }

  private fire(): void {
    this.stop();
    this.deps.stale();
  }

  /** Drops the timer, the rule and any poll still out, without telling the helper. */
  private halt(): void {
    this.cancelEvery?.();
    this.cancelEvery = null;
    this.poll?.abort();
    this.poll = null;
    this.rule = null;
  }
}

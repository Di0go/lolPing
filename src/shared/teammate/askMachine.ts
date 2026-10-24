import type { PingId } from '../pings';

export type AskPhase = 'collecting' | 'gathering' | 'sent' | 'received' | 'answering' | 'done' | 'cancelled' | 'failed';

/** `agentStart`: an agent couldn't be started; `agent`: it stopped without answering. */
export type AskFailure =
  | 'notReceived' | 'timeout' | 'auth' | 'rate' | 'network' | 'images' | 'tools' | 'capture' | 'noProfile' | 'agentStart'
  | 'agent' | 'other';

export interface Spot {
  intent: PingId;
  phys: { x: number; y: number };
  displayId: number;
}

let counter = 0;

/** One ask from the first release to its end; time is passed in so tests control it. */
export class AskMachine {
  readonly id: string;
  phase: AskPhase = 'collecting';
  spots: Spot[] = [];
  failure: AskFailure | null = null;
  private sentAt = 0;
  private readonly receiveMs: number;
  private readonly totalMs: number;

  constructor(private readonly now: () => number, limits?: { receiveMs: number; totalMs: number }) {
    this.receiveMs = limits?.receiveMs ?? 10_000;
    this.totalMs = limits?.totalMs ?? 60_000;
    // A counter keeps ids unique even when two asks start in the same millisecond.
    counter += 1;
    this.id = `ask-${now().toString(36)}-${counter.toString(36)}`;
  }

  addSpot(s: Spot): void {
    if (this.phase === 'collecting') this.spots.push(s);
  }

  startGathering(): void {
    if (this.phase === 'collecting') this.phase = 'gathering';
  }

  sent(): void {
    if (this.phase !== 'collecting' && this.phase !== 'gathering') return;
    this.phase = 'sent';
    this.sentAt = this.now();
  }

  /** True the first time the provider answers, false after that or when the ask is over. */
  received(): boolean {
    if (this.phase !== 'sent') return false;
    this.phase = 'received';
    return true;
  }

  answering(): void {
    if (this.phase === 'sent' || this.phase === 'received') this.phase = 'answering';
  }

  done(): void {
    if (this.accepts()) this.phase = 'done';
  }

  cancel(): void {
    if (this.accepts()) this.phase = 'cancelled';
  }

  fail(reason: AskFailure): void {
    if (!this.accepts()) return;
    this.phase = 'failed';
    this.failure = reason;
  }

  /** Fails the ask when a deadline has passed and says why. */
  tick(): AskFailure | null {
    if (this.phase !== 'sent' && this.phase !== 'received' && this.phase !== 'answering') return null;
    const waited = this.now() - this.sentAt;
    const reason: AskFailure | null = waited >= this.totalMs ? 'timeout'
      : this.phase === 'sent' && waited >= this.receiveMs ? 'notReceived' : null;
    if (reason) this.fail(reason);
    return reason;
  }

  accepts(): boolean {
    return this.phase !== 'done' && this.phase !== 'cancelled' && this.phase !== 'failed';
  }
}

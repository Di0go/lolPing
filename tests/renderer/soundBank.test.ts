import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDLE_SUSPEND_MS, SoundBank } from '../../src/renderer/overlay/soundBank';

/** A Web Audio stand-in that tracks the context's state and lets a test end the playing sources. */
class FakeContext {
  static last: FakeContext;
  state: 'running' | 'suspended' = 'running';
  readonly sources: { onended: (() => void) | null }[] = [];
  destination = {};
  constructor() { FakeContext.last = this; }
  async resume() { this.state = 'running'; }
  async suspend() { this.state = 'suspended'; }
  async decodeAudioData() { return {}; }
  createGain() { return { gain: { value: 1 }, connect: (n: unknown) => n }; }
  createBufferSource() {
    const src = { buffer: null, onended: null as (() => void) | null, connect: (n: unknown) => n, start: () => undefined };
    this.sources.push(src);
    return src;
  }
}

async function loaded(suspendWhenIdle: boolean): Promise<SoundBank> {
  const bank = new SoundBank(suspendWhenIdle);
  vi.stubGlobal('fetch', async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(1) }));
  await bank.load([{ key: 'ping', url: 'ping.ogg' }]);
  return bank;
}

describe('SoundBank', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.stubGlobal('AudioContext', FakeContext); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it('suspends a silent context and resumes it for the next sound', async () => {
    const bank = await loaded(true);
    await vi.advanceTimersByTimeAsync(IDLE_SUSPEND_MS);
    expect(FakeContext.last.state).toBe('suspended');
    bank.play('ping', 1);
    await vi.advanceTimersByTimeAsync(0);
    expect(FakeContext.last.state).toBe('running');
  });
  it('stays open while a sound plays and closes only after the last one ends', async () => {
    const bank = await loaded(true);
    bank.play('ping', 1);
    bank.play('ping', 1);
    await vi.advanceTimersByTimeAsync(IDLE_SUSPEND_MS * 2);
    expect(FakeContext.last.state).toBe('running');
    FakeContext.last.sources[0].onended?.();
    await vi.advanceTimersByTimeAsync(IDLE_SUSPEND_MS);
    expect(FakeContext.last.state).toBe('running');
    FakeContext.last.sources[1].onended?.();
    await vi.advanceTimersByTimeAsync(IDLE_SUSPEND_MS - 1);
    expect(FakeContext.last.state).toBe('running');
    await vi.advanceTimersByTimeAsync(1);
    expect(FakeContext.last.state).toBe('suspended');
  });
  it('a sound inside the grace period keeps the context open', async () => {
    const bank = await loaded(true);
    await vi.advanceTimersByTimeAsync(IDLE_SUSPEND_MS - 10);
    bank.play('ping', 1);
    await vi.advanceTimersByTimeAsync(20);
    expect(FakeContext.last.state).toBe('running');
  });
  it('never suspends where suspendWhenIdle is off (Windows and macOS)', async () => {
    const bank = await loaded(false);
    bank.play('ping', 1);
    FakeContext.last.sources[0].onended?.();
    await vi.advanceTimersByTimeAsync(IDLE_SUSPEND_MS * 3);
    expect(FakeContext.last.state).toBe('running');
  });
});

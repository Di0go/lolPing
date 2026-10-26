/** Safety ceiling: more overlapping sounds than this are skipped (the ping still shows). */
export const MAX_VOICES = 8;

/** How long a silent context stays open for the next sound before it is suspended (when suspendWhenIdle). */
export const IDLE_SUSPEND_MS = 5000;

/** Pre-decoded Web Audio buffers: HTMLAudioElement per play added audible latency in the prototype. */
export class SoundBank {
  private readonly ctx = new AudioContext({ latencyHint: 'interactive' });
  private readonly buffers = new Map<string, AudioBuffer>();
  private voices = 0;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * suspendWhenIdle: a running context keeps an audio stream open, which on Linux wakes the app and the sound
   * server dozens of times a second and keeps the sound card awake, so it is suspended between sounds.
   */
  constructor(private readonly suspendWhenIdle = false) {
    this.idleSoon();
  }

  private idleSoon(): void {
    if (!this.suspendWhenIdle || this.voices > 0) return;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.voices === 0) void this.ctx.suspend();
    }, IDLE_SUSPEND_MS);
  }

  /** Decodes every sound up front, each under its key. Resolves with the URLs that failed to load. */
  async load(entries: readonly { key: string; url: string }[]): Promise<string[]> {
    const results = await Promise.all(
      entries.map(async ({ key, url }) => {
        try {
          const res = await fetch(url);
          if (!res.ok) throw new Error(String(res.status));
          this.buffers.set(key, await this.ctx.decodeAudioData(await res.arrayBuffer()));
          return null;
        } catch {
          return url;
        }
      }),
    );
    return results.filter((r): r is string => r !== null);
  }

  /** Plays the sound at `url`, loading it under that key the first time. A file that won't load plays nothing. */
  async playUrl(url: string, volume01: number): Promise<void> {
    if (!this.buffers.has(url)) await this.load([{ key: url, url }]);
    this.play(url, volume01);
  }

  /** Drops the loaded sounds whose key starts with `prefix`, so the next play loads them again. */
  forget(prefix: string): void {
    for (const key of this.buffers.keys()) if (key.startsWith(prefix)) this.buffers.delete(key);
  }

  play(key: string, volume01: number): void {
    const buffer = this.buffers.get(key);
    if (!buffer || volume01 <= 0 || this.voices >= MAX_VOICES) return;
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
    if (this.ctx.state !== 'running') void this.ctx.resume();
    const src = this.ctx.createBufferSource();
    const gain = this.ctx.createGain();
    src.buffer = buffer;
    gain.gain.value = volume01;
    src.connect(gain).connect(this.ctx.destination);
    this.voices++;
    src.onended = () => {
      this.voices--;
      this.idleSoon();
    };
    src.start();
  }
}

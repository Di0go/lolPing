/** How long an overlay stays empty before it counts as idle: longer than the wheel's 0.12 s fade-out. */
export const IDLE_MS = 250;

/**
 * Tells main whether this overlay has anything on it, so Windows can hide an empty one: a shown window over the whole
 * display, click-through or not, is what screenshot tools pick as the window under the pointer (#127).
 * `report(true)` once `isEmpty()` has held for IDLE_MS, `report(false)` as soon as something shows after that.
 */
export class IdleWatch {
  private idle = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly isEmpty: () => boolean, private readonly report: (idle: boolean) => void) {}

  /** Call whenever something may have appeared on the overlay or left it. */
  check(): void {
    if (!this.isEmpty()) {
      if (this.timer !== null) clearTimeout(this.timer);
      this.timer = null;
      if (this.idle) {
        this.idle = false;
        this.report(false);
      }
      return;
    }
    if (this.idle || this.timer !== null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (!this.isEmpty()) return;
      this.idle = true;
      this.report(true);
    }, IDLE_MS);
  }
}

import type { Platform } from '../../shared/platform';
import type { TriggerKey } from '../../shared/settings';
import { canDoubleTap, type TeammateSettings } from '../../shared/teammate/settings';

export type FirstRunStep = 'askKey' | 'profile' | 'screen' | 'done';

/** 'screen' only on macOS while Screen Recording isn't allowed. */
export function firstRunSteps(platform: Platform, screenAccess: boolean | null): FirstRunStep[] {
  return platform === 'mac' && screenAccess === false
    ? ['askKey', 'profile', 'screen', 'done']
    : ['askKey', 'profile', 'done'];
}

/** The words line of the last step: click, double tap, or none. `askKey` is the key that asks. */
export function wordsHow(t: TeammateSettings, askKey: TriggerKey): 'click' | 'doubleTap' | null {
  if (t.askClick) return 'click';
  return t.askDoubleTap && canDoubleTap(askKey) ? 'doubleTap' : null;
}

/** A change to the teammate settings, or one worked out from the latest of them (null: nothing to change). */
export type TeammateChange = Partial<TeammateSettings> | ((t: TeammateSettings) => Partial<TeammateSettings> | null);

/**
 * Sends the first-run card's changes one after another, each built on the teammate settings the one before returned.
 * The settings the card renders with only change once a save comes back, so a field saved on blur followed at once by
 * Next would otherwise send the old settings and undo it.
 */
export class TeammateChanges {
  private latest: TeammateSettings;
  private tail: Promise<void> = Promise.resolve();
  /** Settings this chain started from or got back: a render with one it has since moved past is not news. */
  private readonly known = new WeakSet<TeammateSettings>();

  constructor(
    start: TeammateSettings,
    private readonly send: (t: TeammateSettings) => Promise<{ settings: { teammate: TeammateSettings } }>,
  ) {
    this.latest = start;
    this.known.add(start);
  }

  /** The settings the card rendered with: newer ones from elsewhere are built on from now on. */
  seen(t: TeammateSettings): void {
    if (this.known.has(t)) return;
    this.latest = t;
  }

  change(c: TeammateChange): Promise<void> {
    const run = this.tail.then(async () => {
      const p = typeof c === 'function' ? c(this.latest) : c;
      if (!p) return;
      const r = await this.send({ ...this.latest, ...p });
      this.known.add(r.settings.teammate);
      this.latest = r.settings.teammate;
    });
    this.tail = run.catch(() => undefined);
    return run;
  }
}

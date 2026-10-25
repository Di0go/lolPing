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

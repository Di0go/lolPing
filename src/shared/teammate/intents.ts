import { strings, type Lang } from '../i18n';
import type { PingId } from '../pings';
import type { TeammateSettings } from './settings';

export type IntentKind = 'answer' | 'continue' | 'guide' | 'act' | 'grab' | 'words' | 'save';

export interface IntentDef {
  id: PingId;
  kind: IntentKind;
  /** Uses the deep profile when one is set. */
  deep: boolean;
  /** Opens the card as the first thing shown. */
  autoCard: boolean;
}

const def = (id: PingId, kind: IntentKind, extra: Partial<Pick<IntentDef, 'deep' | 'autoCard'>> = {}): IntentDef =>
  ({ id, kind, deep: false, autoCard: false, ...extra });

export const INTENTS: Readonly<Record<PingId, IntentDef>> = {
  missing: def('missing', 'answer'),
  push: def('push', 'continue'),
  danger: def('danger', 'answer'),
  assist: def('assist', 'guide'),
  omw: def('omw', 'act'),
  needvision: def('needvision', 'answer'),
  allin: def('allin', 'answer', { deep: true, autoCard: true }),
  enemyvision: def('enemyvision', 'grab'),
  generic: def('generic', 'words'),
  visioncleared: def('visioncleared', 'act'),
  missingflip: def('missingflip', 'answer', { autoCard: true }),
  bait: def('bait', 'save'),
};

/** A user override wins; an empty override string means "use the default". */
export function intentFor(
  s: TeammateSettings,
  id: PingId,
  lang: Lang,
): { def: IntentDef; enabled: boolean; label: string; instruction: string; custom: string } {
  const o = s.intents[id];
  const text = strings(lang).teammate.intent[id];
  return {
    def: INTENTS[id],
    enabled: o?.enabled ?? true,
    label: o?.label || text.label,
    instruction: o?.instruction || text.instruction,
    /** The user's own instruction; '' when they kept the default. */
    custom: o?.instruction ?? '',
  };
}

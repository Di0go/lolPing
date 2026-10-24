import type { IntentId, Profile, TeammateSettings } from './settings';

export type RouteReason = { kind: 'rule'; index: number } | { kind: 'deep' } | { kind: 'doIt' } | { kind: 'default' };

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/** Picks the profile for an ask: app rules first, then the deep and agent defaults, then the default profile. */
export function route(
  t: Pick<TeammateSettings, 'profiles' | 'rules' | 'defaultProfile' | 'deepProfile'>,
  ask: { intent: IntentId; deep: boolean; app: string; title: string },
): { profile: Profile; reason: RouteReason } | null {
  const byId = (id: string | null): Profile | undefined =>
    id === null ? undefined : t.profiles.find((p) => p.id === id);
  const title = ask.title.toLowerCase();

  for (let index = 0; index < t.rules.length; index++) {
    const r = t.rules[index];
    if (!same(r.app, ask.app)) continue;
    if (r.titleContains !== '' && !title.includes(r.titleContains.toLowerCase())) continue;
    if (r.intents.length > 0 && !r.intents.includes(ask.intent)) continue;
    const profile = byId(r.profile);
    if (profile) return { profile, reason: { kind: 'rule', index } };
  }

  if (ask.deep) {
    const profile = byId(t.deepProfile);
    if (profile) return { profile, reason: { kind: 'deep' } };
  }

  if (ask.intent === 'omw') {
    const profile = t.profiles.find((p) => p.kind === 'agent');
    if (profile) return { profile, reason: { kind: 'doIt' } };
  }

  const profile = byId(t.defaultProfile);
  return profile ? { profile, reason: { kind: 'default' } } : null;
}

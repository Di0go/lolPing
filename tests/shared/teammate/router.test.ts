import { describe, expect, it } from 'vitest';
import { route } from '../../../src/shared/teammate/router';
import type { AgentProfile, AppRule, BuiltinProfile, TeammateSettings } from '../../../src/shared/teammate/settings';

const builtin = (id: string): BuiltinProfile => ({
  id, kind: 'builtin', name: id, tagColor: 3, tagColorCustom: null, provider: 'deepseek', protocol: 'openai',
  baseUrl: 'https://api.deepseek.com', model: 'm',
});
const agent = (id: string): AgentProfile => ({
  id, kind: 'agent', name: id, tagColor: 3, tagColorCustom: null, preset: 'claude', command: 'claude', customArgs: [],
  folder: { kind: 'fixed', path: 'C:\\work' }, timeoutS: 300,
});
const rule = (over: Partial<AppRule>): AppRule => ({ app: 'Code', titleContains: '', intents: [], profile: 'agent1', ...over });

type Routing = Pick<TeammateSettings, 'profiles' | 'rules' | 'defaultProfile' | 'deepProfile'>;
const settings = (over: Partial<Routing> = {}): Routing => ({
  profiles: [builtin('fast'), builtin('deep'), agent('agent1'), agent('agent2')],
  rules: [],
  defaultProfile: 'fast',
  deepProfile: 'deep',
  ...over,
});
const ask = (over: Partial<Parameters<typeof route>[1]> = {}): Parameters<typeof route>[1] =>
  ({ intent: 'assist', deep: false, app: 'chrome', title: 'Docs', ...over });

describe('route', () => {
  it('uses the first rule that matches app, title and intent', () => {
    const t = settings({
      rules: [
        rule({ app: 'cursor' }),
        rule({ titleContains: 'readme', profile: 'agent2' }),
        rule({ intents: ['assist', 'missing'], profile: 'fast' }),
        rule({ profile: 'agent2' }),
      ],
    });
    // the app is compared without case; the first rule is for another app, the second wants "readme" in the title
    expect(route(t, ask({ app: 'code', intent: 'assist', title: 'a.ts - x - Visual Studio Code' })))
      .toMatchObject({ profile: { id: 'fast' }, reason: { kind: 'rule', index: 2 } });
    expect(route(t, ask({ app: 'Code', intent: 'omw', title: 'README.md - x - Visual Studio Code' })))
      .toMatchObject({ profile: { id: 'agent2' }, reason: { kind: 'rule', index: 1 } });
    expect(route(t, ask({ app: 'Code', intent: 'danger', title: 'a.ts' })))
      .toMatchObject({ profile: { id: 'agent2' }, reason: { kind: 'rule', index: 3 } });
  });

  it('falls through a rule whose profile is gone', () => {
    const t = settings({ rules: [rule({ profile: 'removed' }), rule({ profile: 'agent2' })] });
    expect(route(t, ask({ app: 'Code' }))).toMatchObject({ profile: { id: 'agent2' }, reason: { kind: 'rule', index: 1 } });
    const lone = settings({ rules: [rule({ profile: 'removed' })], defaultProfile: 'removed', deepProfile: 'removed' });
    expect(route(lone, ask({ app: 'Code' }))).toBeNull();
    expect(route(settings({ deepProfile: 'removed' }), ask({ intent: 'allin', deep: true })))
      .toMatchObject({ profile: { id: 'fast' }, reason: { kind: 'default' } });
  });

  it('sends Whole picture to the deep profile and Do it to the first agent', () => {
    const t = settings();
    expect(route(t, ask({ intent: 'allin', deep: true })))
      .toMatchObject({ profile: { id: 'deep' }, reason: { kind: 'deep' } });
    expect(route(t, ask({ intent: 'omw' }))).toMatchObject({ profile: { id: 'agent1' }, reason: { kind: 'doIt' } });
    // no agent profile: Do it goes to the default one
    const noAgent = settings({ profiles: [builtin('fast'), builtin('deep')] });
    expect(route(noAgent, ask({ intent: 'omw' }))).toMatchObject({ profile: { id: 'fast' }, reason: { kind: 'default' } });
    // a rule still wins over both
    const ruled = settings({ rules: [rule({ app: 'chrome', profile: 'fast' })] });
    expect(route(ruled, ask({ intent: 'allin', deep: true }))).toMatchObject({ reason: { kind: 'rule', index: 0 } });
  });

  it('says why it chose the profile', () => {
    expect(route(settings(), ask())?.reason).toEqual({ kind: 'default' });
    expect(route(settings(), ask({ intent: 'allin', deep: true }))?.reason).toEqual({ kind: 'deep' });
    expect(route(settings(), ask({ intent: 'omw' }))?.reason).toEqual({ kind: 'doIt' });
    expect(route(settings({ rules: [rule({ app: 'chrome' })] }), ask())?.reason).toEqual({ kind: 'rule', index: 0 });
  });
});

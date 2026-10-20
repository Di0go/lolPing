import { describe, expect, it } from 'vitest';
import { DEFAULT_TEAMMATE, normalizeTeammate } from '../../../src/shared/teammate/settings';

const win = { platform: 'win', trigger: 'alt', emoteTrigger: 'ctrl' } as const;

const validProfile = {
  id: 'a', kind: 'builtin', name: 'Main', tagColor: 2, tagColorCustom: null, provider: 'openai', protocol: 'openai',
  baseUrl: 'https://api.openai.com/v1', model: 'gpt-x', vision: 'auto',
};

describe('normalizeTeammate', () => {
  it('fills every default from nothing', () => {
    expect(normalizeTeammate(undefined, win)).toEqual({ ...DEFAULT_TEAMMATE, askClick: true });
    expect(normalizeTeammate(undefined, { ...win, platform: 'mac' })).toEqual({ ...DEFAULT_TEAMMATE, askClick: false });
  });

  it('moves an ask key equal to the ping key to Win: only an explicit same shares the ping key', () => {
    expect(normalizeTeammate({ askTrigger: 'alt' }, win).askTrigger).toBe('win');
    expect(normalizeTeammate({ askTrigger: 'same' }, win).askTrigger).toBe('same');
    // Win is the emote key, so the ask has no free key left and shares the ping key.
    expect(normalizeTeammate({ askTrigger: 'alt' }, { ...win, emoteTrigger: 'win' }).askTrigger).toBe('same');
  });

  it('moves an ask key off the emote key', () => {
    expect(normalizeTeammate({ askTrigger: 'ctrl' }, win).askTrigger).toBe('win');
    // The fallback key is taken too (here by the ping key), so the ask shares the ping key.
    expect(normalizeTeammate({ askTrigger: 'ctrl' }, { ...win, trigger: 'win' }).askTrigger).toBe('same');
  });

  it('treats Caps Lock and its key code as one key', () => {
    expect(normalizeTeammate({ askTrigger: { vk: 0x14 } }, { ...win, trigger: 'capslock' }).askTrigger).toBe('win');
  });

  it('keeps a valid separate ask key and rejects junk', () => {
    expect(normalizeTeammate({ askTrigger: 'mouse4' }, win).askTrigger).toBe('mouse4');
    expect(normalizeTeammate({ askTrigger: { vk: 0x56 } }, win).askTrigger).toEqual({ vk: 0x56 });
    expect(normalizeTeammate({ askTrigger: 'bogus' }, win).askTrigger).toBe('win');
    expect(normalizeTeammate({ askTrigger: 'capslock' }, { ...win, platform: 'mac' }).askTrigger).toBe('win');
  });

  it('drops broken profiles and clears ids that no longer resolve', () => {
    const t = normalizeTeammate(
      { profiles: [validProfile, { kind: 'agent' }, 7], defaultProfile: 'zzz', deepProfile: 'a' }, win,
    );
    expect(t.profiles).toEqual([validProfile]);
    expect(t.defaultProfile).toBeNull();
    expect(t.deepProfile).toBe('a');
  });

  it('drops a profile with an unknown provider or a repeated id', () => {
    const t = normalizeTeammate({ profiles: [validProfile, validProfile, { ...validProfile, id: 'b', provider: 'x' }] }, win);
    expect(t.profiles.map((p) => p.id)).toEqual(['a']);
  });

  it('keeps only intent overrides for known pings', () => {
    const t = normalizeTeammate({ intents: { danger: { enabled: false, label: 'x'.repeat(100) }, nope: {} } }, win);
    expect(t.intents.danger?.enabled).toBe(false);
    expect(t.intents.danger?.label).toHaveLength(40);
    expect('nope' in t.intents).toBe(false);
  });

  it('repairs history numbers', () => {
    expect(normalizeTeammate({ history: { keepDays: -3, maxThreads: 'lots' } }, win).history)
      .toEqual({ on: true, keepDays: 30, maxThreads: 500, paused: false });
    expect(normalizeTeammate({ history: { keepDays: null } }, win).history.keepDays).toBeNull();
  });

  it('repairs the name tag and context flags', () => {
    const t = normalizeTeammate({ tagName: '  ', tagColor: 99, context: { marks: false, files: 'yes' } }, win);
    expect(t.tagName).toBe('AI');
    expect(t.tagColor).toBe(3);
    expect(t.context).toEqual({ ...DEFAULT_TEAMMATE.context, marks: false });
  });
});

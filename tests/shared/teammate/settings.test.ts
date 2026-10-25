import { describe, expect, it } from 'vitest';
import { canDoubleTap, DEFAULT_TEAMMATE, normalizeTeammate } from '../../../src/shared/teammate/settings';

const win = { platform: 'win', trigger: 'alt', emoteTrigger: 'ctrl' } as const;

const validProfile = {
  id: 'a', kind: 'builtin', name: 'Main', tagColor: 2, tagColorCustom: null, provider: 'openai', protocol: 'openai',
  baseUrl: 'https://api.openai.com/v1', model: 'gpt-x',
};

const validAgent = {
  id: 'ag', kind: 'agent', name: 'Claude', tagColor: 1, tagColorCustom: null, preset: 'claude', command: 'claude',
  customArgs: [], folder: { kind: 'editor', folders: ['C:\\code'] }, timeoutS: 300,
};

describe('normalizeTeammate', () => {
  it('fills every default from nothing', () => {
    expect(normalizeTeammate(undefined, win)).toEqual({ ...DEFAULT_TEAMMATE, askClick: true, askDoubleTap: false });
    expect(normalizeTeammate(undefined, { ...win, platform: 'mac' })).toEqual({ ...DEFAULT_TEAMMATE, askClick: false, askDoubleTap: true });
  });

  it('turns double tap on by default only on macOS', () => {
    expect(normalizeTeammate({}, win).askDoubleTap).toBe(false);
    expect(normalizeTeammate({}, { ...win, platform: 'mac' }).askDoubleTap).toBe(true);
    expect(normalizeTeammate({ askDoubleTap: false }, { ...win, platform: 'mac' }).askDoubleTap).toBe(false);
    expect(normalizeTeammate({ askDoubleTap: true }, win).askDoubleTap).toBe(true);
    expect(normalizeTeammate({ askDoubleTap: 'yes' }, { ...win, platform: 'mac' }).askDoubleTap).toBe(true);
  });

  it('offers double tap for a modifier key only', () => {
    for (const k of ['alt', 'ctrl', 'shift', 'win'] as const) expect(canDoubleTap(k), k).toBe(true);
    for (const k of ['capslock', 'mouse4', 'mouse5', { vk: 0x47 }] as const) expect(canDoubleTap(k), JSON.stringify(k)).toBe(false);
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

  it('drops the old vision key', () => {
    const t = normalizeTeammate({ profiles: [{ ...validProfile, vision: 'no' }] }, win);
    expect(t.profiles).toEqual([validProfile]);
    expect('vision' in (t.profiles[0] ?? {})).toBe(false);
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

  it('keeps the form paste switch off for an old file and reads it when given', () => {
    expect(normalizeTeammate({ context: { marks: true } }, win).context.clipboardForForms).toBe(false);
    expect(normalizeTeammate({ context: { clipboardForForms: true } }, win).context.clipboardForForms).toBe(true);
    expect(normalizeTeammate({ context: { clipboardForForms: 1 } }, win).context.clipboardForForms).toBe(false);
  });

  it('drops permissions for a missing profile or an unknown action', () => {
    const t = normalizeTeammate({
      profiles: [validProfile],
      permissions: ['a:paste', 'a:fill', 'a:open', 'gone:paste', 'a:shred', 'a:', ':paste', 'a', 'a:paste', 7, null, 'a:event'],
    }, win);
    expect(t.permissions).toEqual(['a:paste', 'a:open', 'a:event']);
  });

  it('drops every permission when there is no profile', () => {
    expect(normalizeTeammate({ permissions: ['a:paste'] }, win).permissions).toEqual([]);
  });

  it('keeps a valid agent profile and fills its defaults', () => {
    expect(normalizeTeammate({ profiles: [validAgent] }, win).profiles).toEqual([validAgent]);
    const bare = { id: 'b', kind: 'agent', name: 'Bare', preset: 'custom', command: 'my-agent' };
    expect(normalizeTeammate({ profiles: [bare] }, win).profiles).toEqual([{
      id: 'b', kind: 'agent', name: 'Bare', tagColor: DEFAULT_TEAMMATE.tagColor, tagColorCustom: null, preset: 'custom',
      command: 'my-agent', customArgs: [], folder: { kind: 'editor', folders: [] }, timeoutS: 300,
    }]);
  });

  it('keeps a fixed folder and drops empty or extra editor folders', () => {
    const fixed = { ...validAgent, folder: { kind: 'fixed', path: 'D:\\work' } };
    expect(normalizeTeammate({ profiles: [fixed] }, win).profiles[0]).toEqual(fixed);
    const many = { ...validAgent, folder: { kind: 'editor', folders: ['', 'a', 7, 'x'.repeat(1025), ...Array(30).fill('f')] } };
    const folder = (normalizeTeammate({ profiles: [many] }, win).profiles[0] as { folder: { folders: string[] } }).folder;
    expect(folder.folders).toHaveLength(20);
    expect(folder.folders.slice(0, 2)).toEqual(['a', 'f']);
  });

  it('clamps the timeout to 30 s .. 30 min', () => {
    const timeout = (v: unknown) => (normalizeTeammate({ profiles: [{ ...validAgent, timeoutS: v }] }, win).profiles[0] as
      { timeoutS: number }).timeoutS;
    expect(timeout(1)).toBe(30);
    expect(timeout(99999)).toBe(1800);
    expect(timeout(120.4)).toBe(120);
    expect(timeout('soon')).toBe(300);
    expect(timeout(undefined)).toBe(300);
  });

  it('drops an agent profile without a command', () => {
    for (const command of ['', '   ', 7, undefined, 'x'.repeat(1025)]) {
      expect(normalizeTeammate({ profiles: [{ ...validAgent, command }] }, win).profiles, String(command)).toEqual([]);
    }
    expect(normalizeTeammate({ profiles: [{ ...validAgent, preset: 'nope' }] }, win).profiles).toEqual([]);
  });

  it('limits custom arguments to 40 lines of 1,024 characters', () => {
    const args = ['--go', 'x'.repeat(1025), 5, ...Array(60).fill('a')];
    const t = normalizeTeammate({ profiles: [{ ...validAgent, preset: 'custom', customArgs: args }] }, win);
    const kept = (t.profiles[0] as { customArgs: string[] }).customArgs;
    expect(kept).toHaveLength(40);
    expect(kept[0]).toBe('--go');
    expect(kept.every((a) => a.length <= 1024)).toBe(true);
  });

  it('drops rules for unknown profiles and unknown intents', () => {
    const t = normalizeTeammate({
      profiles: [validProfile, validAgent],
      rules: [
        { app: ' Code.exe ', titleContains: 'repo', intents: ['danger', 'nope', 7], profile: 'ag' },
        { app: 'Code.exe', titleContains: '', intents: ['danger'], profile: 'gone' },
        { app: '  ', titleContains: '', intents: [], profile: 'a' },
        { app: 'Code.exe', titleContains: '', intents: [], profile: 'a' },
        { app: 'Code.exe', titleContains: '', intents: [], profile: 'a' },
        'junk',
      ],
    }, win);
    expect(t.rules).toEqual([
      { app: 'Code.exe', titleContains: 'repo', intents: ['danger'], profile: 'ag' },
      { app: 'Code.exe', titleContains: '', intents: [], profile: 'a' },
      { app: 'Code.exe', titleContains: '', intents: [], profile: 'a' },
    ]);
  });

  it('keeps at most 50 rules', () => {
    const rule = { app: 'x', titleContains: '', intents: [], profile: 'a' };
    expect(normalizeTeammate({ profiles: [validProfile], rules: Array(80).fill(rule) }, win).rules).toHaveLength(50);
  });

  it('reads an old settings file without rules or agentsCanPing', () => {
    const t = normalizeTeammate({ profiles: [validProfile], tagName: 'Old' }, win);
    expect(t.rules).toEqual([]);
    expect(t.agentsCanPing).toBe(false);
    expect(normalizeTeammate({ agentsCanPing: true }, win).agentsCanPing).toBe(true);
    expect(normalizeTeammate({ agentsCanPing: 'yes' }, win).agentsCanPing).toBe(false);
  });

  it('keeps agent permission keys but never one for a shell tool', () => {
    const t = normalizeTeammate({
      profiles: [validProfile, validAgent],
      permissions: [
        'ag:agent:Edit', 'ag:agent:Read', 'ag:agent:Bash', 'ag:agent:PowerShell', 'ag:agent:run_shell_command',
        'ag:agent:exec_command', 'gone:agent:Edit', 'ag:agent:', 'a:paste',
      ],
    }, win);
    expect(t.permissions).toEqual(['ag:agent:Edit', 'ag:agent:Read', 'a:paste']);
  });
});

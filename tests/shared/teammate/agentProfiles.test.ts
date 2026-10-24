import { describe, expect, it } from 'vitest';
import {
  agentNotes, defaultAfterAdd, newAgentProfile, openInRows, resumableProfile, resumeArgs, timeoutMinutes,
  timeoutSeconds, withFolder,
} from '../../../src/shared/teammate/agentProfiles';
import { AGENT_PRESET_IDS, AGENT_PRESETS } from '../../../src/shared/teammate/agents';
import { MAX_FOLDERS, normalizeTeammate, type AgentProfile } from '../../../src/shared/teammate/settings';

const WIN = { platform: 'win', trigger: 'alt', emoteTrigger: 'ctrl' } as const;

describe('defaultAfterAdd', () => {
  const agent = (preset: 'claude' | 'custom') =>
    newAgentProfile({ id: 'new', preset, tagColor: 0, customName: 'Custom command' });

  it('makes the first profile added the default, unless it is a custom command', () => {
    expect(defaultAfterAdd(null, agent('claude'))).toBe('new');
    expect(defaultAfterAdd(null, agent('custom'))).toBeNull();
  });

  it('keeps the default there is', () => {
    expect(defaultAfterAdd('old', agent('claude'))).toBe('old');
    expect(defaultAfterAdd('old', agent('custom'))).toBe('old');
  });
});

describe('newAgentProfile', () => {
  const base = { id: 'p1', tagColor: 5 };

  it('starts a preset with its name, its command, the editor folder list and 300 s', () => {
    expect(newAgentProfile({ ...base, preset: 'claude', customName: 'Custom command' })).toEqual({
      id: 'p1', kind: 'agent', name: 'Claude Code', tagColor: 5, tagColorCustom: null, preset: 'claude',
      command: 'claude', customArgs: [], folder: { kind: 'editor', folders: [] }, timeoutS: 300,
    });
  });

  it('starts a custom command with the localized name and one {prompt} argument line', () => {
    const p = newAgentProfile({ ...base, preset: 'custom', customName: '自定义命令' });
    expect(p).toMatchObject({ name: '自定义命令', preset: 'custom', customArgs: ['{prompt}'] });
    expect(p.command).not.toBe('');
  });

  it('gives a profile the settings file keeps whole, for every preset and for custom', () => {
    for (const preset of [...AGENT_PRESET_IDS, 'custom'] as const) {
      const p = newAgentProfile({ ...base, preset, customName: 'Custom command' });
      expect(normalizeTeammate({ profiles: [p] }, WIN).profiles).toEqual([p]);
    }
  });
});

describe('timeout minutes', () => {
  it('shows seconds as whole minutes from 1 to 30', () => {
    expect(timeoutMinutes(300)).toBe(5);
    expect(timeoutMinutes(30)).toBe(1);
    expect(timeoutMinutes(1800)).toBe(30);
    expect(timeoutMinutes(90)).toBe(2);
  });

  it('saves minutes times 60, keeping to 1 to 30', () => {
    expect(timeoutSeconds(5)).toBe(300);
    expect(timeoutSeconds(0)).toBe(60);
    expect(timeoutSeconds(99)).toBe(1800);
    expect(timeoutSeconds(2.6)).toBe(180);
    expect(timeoutSeconds(Number.NaN)).toBe(300);
  });
});

describe('withFolder', () => {
  it('adds a folder at the end', () => {
    expect(withFolder(['C:\\a'], 'C:\\b')).toEqual(['C:\\a', 'C:\\b']);
  });

  it('does not add one that is already in the list, is too long, or comes past the limit', () => {
    expect(withFolder(['C:\\a'], 'C:\\a')).toEqual(['C:\\a']);
    expect(withFolder(['C:\\a'], 'x'.repeat(1025))).toEqual(['C:\\a']);
    const full = Array.from({ length: MAX_FOLDERS }, (_, i) => `/f${i}`);
    expect(withFolder(full, '/new')).toEqual(full);
  });
});

describe('agentNotes', () => {
  it('names the approvals first, then untested, then how to add lolPing, for a preset that needs it', () => {
    expect(agentNotes('claude')).toEqual([{ kind: 'approvals', approvals: 'asks' }]);
    expect(agentNotes('cursor')).toEqual([
      { kind: 'approvals', approvals: 'own' }, { kind: 'untested' },
      { kind: 'addMcp', file: '~/.cursor/mcp.json', bin: 'cursor-agent' },
    ]);
  });

  it('says dsh edits freely and which model it uses, and names the mcp add command when no file is known', () => {
    expect(agentNotes('dsh')).toEqual([{ kind: 'approvals', approvals: 'none' }, { kind: 'dsh' }]);
    expect(agentNotes('qoder')).toContainEqual({ kind: 'addMcp', file: null, bin: 'qodercli' });
  });

  it('has no notes for a custom command', () => {
    expect(agentNotes('custom')).toEqual([]);
  });

  it('marks exactly the presets that are not checked as untested', () => {
    for (const id of AGENT_PRESET_IDS) {
      expect(agentNotes(id).some((n) => n.kind === 'untested')).toBe(!AGENT_PRESETS[id].checked);
    }
  });
});

describe('resumeArgs', () => {
  const profile = (preset: AgentProfile['preset']): AgentProfile =>
    newAgentProfile({ id: 'p1', preset, customName: 'Custom command', tagColor: 1 });

  it('continues a session with the preset\'s own flags', () => {
    expect(resumeArgs(profile('claude'), 'sess-1')).toEqual(['--resume', 'sess-1']);
    expect(resumeArgs(profile('dsh'), 'sess-1')).toEqual(['tui', '--resume', 'sess-1']);
  });

  it('has nothing to open for a custom command or an agent that can\'t resume', () => {
    expect(resumeArgs(profile('custom'), 'sess-1')).toBeNull();
    expect(resumeArgs(profile('auggie'), 'sess-1')).toBeNull();
  });

  it('refuses a session id that would read as a flag', () => {
    expect(resumeArgs(profile('claude'), '--dangerously-skip-permissions')).toBeNull();
    expect(resumeArgs(profile('claude'), '-x')).toBeNull();
    expect(resumeArgs(profile('claude'), 'a-b')).toEqual(['--resume', 'a-b']);
  });
});

describe('resumableProfile', () => {
  const agent = (id: string, preset: AgentProfile['preset']): AgentProfile =>
    newAgentProfile({ id, preset, customName: 'Custom command', tagColor: 1 });
  const builtin = normalizeTeammate({
    profiles: [{ id: 'b1', kind: 'builtin', name: 'GPT', provider: 'openai', protocol: 'openai', baseUrl: 'https://x', model: 'm' }],
  }, WIN).profiles[0];

  it('finds the agent profile a thread was answered by', () => {
    const claude = agent('c1', 'claude');
    expect(resumableProfile([builtin, claude], 'c1')).toBe(claude);
  });

  it('is null when the profile is gone, is not an agent, is custom or cannot resume', () => {
    const profiles = [builtin, agent('c2', 'custom'), agent('a1', 'auggie')];
    for (const id of ['missing', 'b1', 'c2', 'a1']) expect(resumableProfile(profiles, id)).toBeNull();
  });
});

describe('openInRows', () => {
  const claude = newAgentProfile({ id: 'c1', preset: 'claude', customName: 'Custom command', tagColor: 1 });
  const rows = [{ id: 't1', agent: 'c1' }, { id: 't2', agent: 'gone' }, { id: 't3' }];

  it('names the agent profile on a thread only when Open in applies', () => {
    expect(openInRows(rows, [claude])).toEqual([{ id: 't1', agent: 'Claude Code' }, { id: 't2' }, { id: 't3' }]);
  });

  it('drops the profile id from threads that can\'t be opened', () => {
    expect(openInRows(rows, [])).toEqual([{ id: 't1' }, { id: 't2' }, { id: 't3' }]);
    for (const row of openInRows(rows, [])) expect('agent' in row).toBe(false);
  });
});

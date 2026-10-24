import { AGENT_PRESETS, type AgentPresetId } from './agents';
import { MAX_FOLDERS, PATH_MAX, TIMEOUT_DEFAULT_S, type AgentProfile, type Profile } from './settings';

const TIMEOUT_MIN_MINUTES = 1;
const TIMEOUT_MAX_MINUTES = 30;
/** What a new custom command runs until the user types theirs: settings keep no profile with an empty command. */
const CUSTOM_COMMAND = 'my-agent';

/** A profile for a preset (or a custom command) with the settings page's starting values. */
export function newAgentProfile(
  o: { id: string; preset: AgentPresetId | 'custom'; customName: string; tagColor: number },
): AgentProfile {
  const preset = o.preset === 'custom' ? null : AGENT_PRESETS[o.preset];
  return {
    id: o.id, kind: 'agent', name: preset ? preset.name : o.customName, tagColor: o.tagColor, tagColorCustom: null,
    preset: o.preset, command: preset ? preset.bin : CUSTOM_COMMAND, customArgs: preset ? [] : ['{prompt}'],
    folder: { kind: 'editor', folders: [] }, timeoutS: TIMEOUT_DEFAULT_S,
  };
}

/**
 * The default profile once `added` is added: the first one becomes it, but not a custom command, which runs only
 * once the user has typed theirs and picks it.
 */
export function defaultAfterAdd(current: string | null, added: Profile): string | null {
  return current ?? (added.kind === 'agent' && added.preset === 'custom' ? null : added.id);
}

const clampMinutes = (m: number): number => Math.min(TIMEOUT_MAX_MINUTES, Math.max(TIMEOUT_MIN_MINUTES, Math.round(m)));

/** The time limit as the whole minutes the page shows, 1 to 30. */
export const timeoutMinutes = (seconds: number): number => clampMinutes(seconds / 60);

/** Minutes from the page as the seconds settings keep; anything that isn't a number gives the 5 minute default. */
export const timeoutSeconds = (minutes: number): number =>
  (Number.isFinite(minutes) ? clampMinutes(minutes) * 60 : TIMEOUT_DEFAULT_S);

/** The editor folder list with `path` added; unchanged when it is there already, too long, or the list is full. */
export function withFolder(folders: readonly string[], path: string): string[] {
  const full = folders.length >= MAX_FOLDERS;
  return full || path === '' || path.length > PATH_MAX || folders.includes(path) ? [...folders] : [...folders, path];
}

export type AgentNote =
  | { kind: 'approvals'; approvals: 'asks' | 'own' | 'none' }
  | { kind: 'untested' }
  /** `file`: where the agent keeps its MCP servers; null when the agent has its own `<bin> mcp add` command. */
  | { kind: 'addMcp'; file: string | null; bin: string }
  | { kind: 'dsh' };

/** The notes under an agent's card, in the order they are shown, and only those that apply. */
export function agentNotes(preset: AgentPresetId | 'custom'): AgentNote[] {
  if (preset === 'custom') return [];
  const p = AGENT_PRESETS[preset];
  const notes: AgentNote[] = [{ kind: 'approvals', approvals: p.approvals }];
  if (!p.checked) notes.push({ kind: 'untested' });
  if (p.mcp === 'user') notes.push({ kind: 'addMcp', file: p.userConfig ?? null, bin: p.bin });
  if (preset === 'dsh') notes.push({ kind: 'dsh' });
  return notes;
}

/** argv that continues `session` in a terminal; null for a custom command and for an agent that can't resume. */
export function resumeArgs(p: AgentProfile, session: string): string[] | null {
  // A session id comes from the agent's own output; one that reads as a flag would be taken as one.
  if (p.preset === 'custom' || session.startsWith('-')) return null;
  const args = AGENT_PRESETS[p.preset].openArgs(session);
  return args.length === 0 ? null : args;
}

/** The agent profile that can continue a thread's session; null when it is gone, custom or can't resume. */
export function resumableProfile(profiles: readonly Profile[], profileId: string): AgentProfile | null {
  const p = profiles.find((x) => x.id === profileId);
  return p !== undefined && p.kind === 'agent' && resumeArgs(p, 'x') !== null ? p : null;
}

/** History rows with `agent` (a profile id) turned into that profile's name, or left out when Open in can't apply. */
export function openInRows<T extends { agent?: string }>(rows: readonly T[], profiles: readonly Profile[]):
  (Omit<T, 'agent'> & { agent?: string })[] {
  return rows.map(({ agent, ...row }) => {
    const profile = agent === undefined ? null : resumableProfile(profiles, agent);
    return profile ? { ...row, agent: profile.name } : row;
  });
}

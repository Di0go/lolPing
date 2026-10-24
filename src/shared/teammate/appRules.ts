import type { PingId } from '../pings';
import { MAX_RULES, type AppRule } from './settings';

/** The pings an editor rule sends to the agent: Do it and What's wrong. */
const EDITOR_INTENTS: PingId[] = ['omw', 'danger'];

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/** `rules` with the rule at `index` moved one place up (-1) or down (1); a move off either end changes nothing. */
export function moveRule(rules: readonly AppRule[], index: number, by: -1 | 1): AppRule[] {
  const to = index + by;
  if (index < 0 || index >= rules.length || to < 0 || to >= rules.length) return [...rules];
  const next = [...rules];
  [next[index], next[to]] = [next[to], next[index]];
  return next;
}

/** A rule for every ping from `app`, at the end of the list; the list is unchanged for an empty name or a full list. */
export function addRule(rules: readonly AppRule[], app: string, profile: string): AppRule[] {
  const name = app.trim();
  if (name === '' || rules.length >= MAX_RULES) return [...rules];
  return [...rules, { app: name, titleContains: '', intents: [], profile }];
}

export type EditorRulesResult =
  | { kind: 'added'; rules: AppRule[]; added: number }
  /** Why nothing was added. */
  | { kind: 'noAgent' } | { kind: 'noEditors' } | { kind: 'exists' };

/** Rules that send Do it and What's wrong from each installed editor to `agent`, skipping editors that have a rule. */
export function editorRules(editors: readonly string[], rules: readonly AppRule[], agent: string | null):
  EditorRulesResult {
  if (agent === null) return { kind: 'noAgent' };
  if (editors.length === 0) return { kind: 'noEditors' };
  const next = [...rules];
  for (const app of editors) {
    if (next.length >= MAX_RULES) break;
    if (next.some((r) => same(r.app, app))) continue;
    next.push({ app, titleContains: '', intents: [...EDITOR_INTENTS], profile: agent });
  }
  const added = next.length - rules.length;
  return added === 0 ? { kind: 'exists' } : { kind: 'added', rules: next, added };
}

/** `apps` with `app` first and no other spelling of it, cut to `limit`; the same list for an empty name. */
export function rememberApp(apps: readonly string[], app: string, limit: number): readonly string[] {
  const name = app.trim();
  if (name === '') return apps;
  return [name, ...apps.filter((a) => !same(a, name))].slice(0, limit);
}

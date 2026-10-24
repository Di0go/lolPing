import { describe, expect, it } from 'vitest';
import {
  addRule, editorRules, moveRule, rememberApp, type EditorRulesResult,
} from '../../../src/shared/teammate/appRules';
import { MAX_RULES, type AppRule } from '../../../src/shared/teammate/settings';

const rule = (app: string, profile = 'a1'): AppRule => ({ app, titleContains: '', intents: [], profile });

describe('moveRule', () => {
  const rules = [rule('A'), rule('B'), rule('C')];

  it('swaps a rule with its neighbour', () => {
    expect(moveRule(rules, 1, -1).map((r) => r.app)).toEqual(['B', 'A', 'C']);
    expect(moveRule(rules, 1, 1).map((r) => r.app)).toEqual(['A', 'C', 'B']);
  });

  it('leaves the list alone at either end, and leaves the old list untouched', () => {
    expect(moveRule(rules, 0, -1).map((r) => r.app)).toEqual(['A', 'B', 'C']);
    expect(moveRule(rules, 2, 1).map((r) => r.app)).toEqual(['A', 'B', 'C']);
    expect(moveRule(rules, 7, 1).map((r) => r.app)).toEqual(['A', 'B', 'C']);
    expect(rules.map((r) => r.app)).toEqual(['A', 'B', 'C']);
  });
});

describe('addRule', () => {
  it('adds a rule for every ping, with no title, at the end', () => {
    expect(addRule([rule('A')], '  Code ', 'p1')).toEqual([
      rule('A'), { app: 'Code', titleContains: '', intents: [], profile: 'p1' },
    ]);
  });

  it('refuses an empty name and a full list', () => {
    expect(addRule([rule('A')], '   ', 'p1')).toEqual([rule('A')]);
    const full = Array.from({ length: MAX_RULES }, (_, i) => rule(`app${i}`));
    expect(addRule(full, 'Code', 'p1')).toHaveLength(MAX_RULES);
  });
});

describe('editorRules', () => {
  it('adds Do it and What\'s wrong for each editor that has no rule yet', () => {
    const r = editorRules(['Code', 'Cursor', 'idea64'], [rule('cursor')], 'agent1');
    expect(r).toEqual<EditorRulesResult>({
      kind: 'added',
      rules: [
        rule('cursor'),
        { app: 'Code', titleContains: '', intents: ['omw', 'danger'], profile: 'agent1' },
        { app: 'idea64', titleContains: '', intents: ['omw', 'danger'], profile: 'agent1' },
      ],
      added: 2,
    });
  });

  it('says why nothing was added', () => {
    expect(editorRules(['Code'], [], null)).toEqual({ kind: 'noAgent' });
    expect(editorRules([], [], 'agent1')).toEqual({ kind: 'noEditors' });
    expect(editorRules(['Code'], [rule('CODE')], 'agent1')).toEqual({ kind: 'exists' });
  });

  it('stops at the most rules settings keep', () => {
    const nearlyFull = Array.from({ length: MAX_RULES - 1 }, (_, i) => rule(`app${i}`));
    const r = editorRules(['Code', 'Cursor'], nearlyFull, 'agent1');
    expect(r.kind).toBe('added');
    if (r.kind === 'added') expect(r.rules).toHaveLength(MAX_RULES);
  });
});

describe('rememberApp', () => {
  it('keeps the newest first, once each ignoring case, and at most the limit', () => {
    expect(rememberApp(['Code', 'Chrome'], 'chrome', 3)).toEqual(['chrome', 'Code']);
    expect(rememberApp(['a', 'b', 'c'], 'd', 3)).toEqual(['d', 'a', 'b']);
  });

  it('ignores an empty name', () => {
    const list = ['a'];
    expect(rememberApp(list, '  ', 3)).toBe(list);
  });
});

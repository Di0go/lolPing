import { describe, expect, it } from 'vitest';
import { ALL_PINGS } from '../../../src/shared/pings';
import { INTENTS, intentFor } from '../../../src/shared/teammate/intents';
import { DEFAULT_TEAMMATE, type TeammateSettings } from '../../../src/shared/teammate/settings';

const withIntents = (intents: TeammateSettings['intents']): TeammateSettings => ({ ...DEFAULT_TEAMMATE, intents });

describe('intents', () => {
  it('gives every ping an intent', () => {
    expect(ALL_PINGS.every((p) => INTENTS[p.id] !== undefined && INTENTS[p.id].id === p.id)).toBe(true);
  });

  it('marks the deep and auto-card intents as specified', () => {
    expect(INTENTS.allin).toMatchObject({ kind: 'answer', deep: true, autoCard: true });
    expect(INTENTS.missingflip).toMatchObject({ kind: 'answer', deep: false, autoCard: true });
    expect(INTENTS.omw.kind).toBe('act');
    expect(INTENTS.bait.kind).toBe('save');
  });

  it('uses the default label and instruction with no override', () => {
    const r = intentFor(DEFAULT_TEAMMATE, 'danger', 'en');
    expect(r.def).toBe(INTENTS.danger);
    expect(r.enabled).toBe(true);
    expect(r.label).toBe("What's wrong");
    expect(r.instruction.length).toBeGreaterThan(0);
    expect(intentFor(DEFAULT_TEAMMATE, 'danger', 'zh-CN').label).toBe('哪里不对');
  });

  it('uses the label and instruction override when set', () => {
    const r = intentFor(withIntents({ danger: { label: 'Bugs', instruction: 'Find bugs only.' } }), 'danger', 'en');
    expect(r.label).toBe('Bugs');
    expect(r.instruction).toBe('Find bugs only.');
  });

  it('falls back to the default for an empty override', () => {
    const base = intentFor(DEFAULT_TEAMMATE, 'push', 'en');
    const r = intentFor(withIntents({ push: { label: '', instruction: '' } }), 'push', 'en');
    expect(r.label).toBe(base.label);
    expect(r.instruction).toBe(base.instruction);
  });

  it('reports a switched-off intent', () => {
    expect(intentFor(withIntents({ bait: { enabled: false } }), 'bait', 'en').enabled).toBe(false);
    expect(intentFor(withIntents({ bait: { enabled: true } }), 'bait', 'en').enabled).toBe(true);
  });
});

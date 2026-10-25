import { describe, expect, it } from 'vitest';
import { firstRunSteps, TeammateChanges, wordsHow } from '../../src/renderer/settings/firstRun';
import { DEFAULT_TEAMMATE, type AppRule, type TeammateSettings } from '../../src/shared/teammate/settings';

const mate = (p: Partial<TeammateSettings>): TeammateSettings => ({ ...DEFAULT_TEAMMATE, ...p });
const RULE: AppRule = { app: 'Code', titleContains: '', intents: ['omw'], profile: 'p1' };

describe('firstRunSteps', () => {
  it('asks for Screen Recording only on a Mac without it', () => {
    expect(firstRunSteps('mac', false)).toEqual(['askKey', 'profile', 'screen', 'done']);
    expect(firstRunSteps('mac', true)).toEqual(['askKey', 'profile', 'done']);
    expect(firstRunSteps('mac', null)).toEqual(['askKey', 'profile', 'done']);
    expect(firstRunSteps('win', null)).toEqual(['askKey', 'profile', 'done']);
    expect(firstRunSteps('win', false)).toEqual(['askKey', 'profile', 'done']);
  });
});

describe('wordsHow', () => {
  it('says click on Windows and double tap on a Mac', () => {
    expect(wordsHow(mate({ askClick: true, askDoubleTap: false }), 'win')).toBe('click');
    expect(wordsHow(mate({ askClick: false, askDoubleTap: true }), 'win')).toBe('doubleTap');
  });

  it('says nothing about words when both are off', () => {
    expect(wordsHow(mate({ askClick: false, askDoubleTap: false }), 'win')).toBeNull();
  });

  it('skips double tap for a key that can only be clicked', () => {
    expect(wordsHow(mate({ askClick: false, askDoubleTap: true }), 'mouse5')).toBeNull();
    expect(wordsHow(mate({ askClick: true, askDoubleTap: true }), 'mouse5')).toBe('click');
  });
});

/** A fake main process: each save resolves when the test says, and returns a fresh copy as IPC would. */
function store(start: TeammateSettings) {
  const sent: TeammateSettings[] = [];
  const returned: TeammateSettings[] = [];
  const waiting: Array<() => void> = [];
  const send = (t: TeammateSettings) => {
    sent.push(t);
    return new Promise<{ settings: { teammate: TeammateSettings } }>((resolve) => {
      waiting.push(() => {
        const teammate = { ...t };
        returned.push(teammate);
        resolve({ settings: { teammate } });
      });
    });
  };
  /** Lets the chain run up to its next save. */
  const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
  /** Answers the oldest save, and lets the chain send the next. */
  const answer = async (): Promise<void> => {
    await settle();
    waiting.shift()?.();
    await settle();
  };
  return { changes: new TeammateChanges(start, send), sent, returned, answer, settle };
}

describe('TeammateChanges', () => {
  it('builds each change on what the one before returned, not on the settings the card rendered with', async () => {
    const start = mate({ tagName: 'Mate' });
    const s = store(start);
    // A name saved on blur, then Next with the editor rules before the name's save came back.
    void s.changes.change({ tagName: 'Ada' });
    void s.changes.change((latest) => ({ rules: [...latest.rules, RULE] }));
    await s.settle();
    expect(s.sent).toHaveLength(1);
    await s.answer();
    expect(s.sent).toHaveLength(2);
    expect(s.sent[1].tagName).toBe('Ada');
    expect(s.sent[1].rules).toEqual([RULE]);
  });

  it('sends nothing for a change worked out as none', async () => {
    const s = store(mate({}));
    const done = s.changes.change(() => null);
    await done;
    expect(s.sent).toEqual([]);
  });

  it('builds on newer settings from elsewhere, but not on a render it has moved past', async () => {
    const s = store(mate({ tagName: 'Mate' }));
    s.changes.seen(mate({ tagName: 'Pushed' }));
    void s.changes.change({ askClick: true });
    await s.settle();
    expect(s.sent[0]).toMatchObject({ tagName: 'Pushed', askClick: true });
    await s.answer();
    void s.changes.change({ tagName: 'Ada' });
    await s.answer();
    // A late render with the first save's settings doesn't take back the second.
    s.changes.seen(s.returned[0]);
    void s.changes.change({ emotes: false });
    await s.settle();
    expect(s.sent[2]).toMatchObject({ tagName: 'Ada', askClick: true, emotes: false });
  });

  it('keeps going after a save that failed', async () => {
    const sent: TeammateSettings[] = [];
    let fail = true;
    const changes = new TeammateChanges(mate({}), async (t) => {
      sent.push(t);
      if (fail) throw new Error('ipc');
      return { settings: { teammate: t } };
    });
    await expect(changes.change({ tagName: 'Ada' })).rejects.toThrow('ipc');
    fail = false;
    await changes.change({ askClick: true });
    expect(sent).toHaveLength(2);
  });
});

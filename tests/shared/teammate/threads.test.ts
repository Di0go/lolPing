import { describe, expect, it } from 'vitest';
import { threadAction, wordsContinuesByDefault, type ThreadRef } from '../../../src/shared/teammate/threads';

const thread: ThreadRef = { id: 't1', title: 'Baron', lastActivity: 1_000_000 };

describe('threadAction', () => {
  it('starts a thread for every intent except push', () => {
    for (const intent of ['missing', 'danger', 'assist', 'omw', 'allin', 'enemyvision'] as const) {
      expect(threadAction(intent, thread, { onTeammate: false })).toBe('new');
    }
  });

  it('continues with push and starts one when there is none', () => {
    expect(threadAction('push', thread, { onTeammate: false })).toBe('continue');
    expect(threadAction('push', null, { onTeammate: false })).toBe('new');
    expect(threadAction('danger', thread, { onTeammate: true })).toBe('continue');
    expect(threadAction('danger', null, { onTeammate: true })).toBe('new');
  });

  it('continues a recent thread with words unless asked not to', () => {
    expect(threadAction('generic', thread, { onTeammate: false })).toBe('continue');
    expect(threadAction('generic', thread, { onTeammate: false, newThread: true })).toBe('new');
    expect(threadAction('generic', null, { onTeammate: false })).toBe('new');
  });

  it('defaults words to a new thread after five quiet minutes', () => {
    expect(wordsContinuesByDefault(thread, 1_000_000 + 300_000)).toBe(true);
    expect(wordsContinuesByDefault(thread, 1_000_000 + 300_001)).toBe(false);
    expect(wordsContinuesByDefault(null, 0)).toBe(false);
  });
});

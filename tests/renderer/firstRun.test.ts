import { describe, expect, it } from 'vitest';
import { firstRunSteps, wordsHow } from '../../src/renderer/settings/firstRun';
import { DEFAULT_TEAMMATE, type TeammateSettings } from '../../src/shared/teammate/settings';

const mate = (p: Partial<TeammateSettings>): TeammateSettings => ({ ...DEFAULT_TEAMMATE, ...p });

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

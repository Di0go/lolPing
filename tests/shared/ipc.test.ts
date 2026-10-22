import { describe, expect, it } from 'vitest';
import { OVERLAY_CHANNELS, parseMateGlow, parsePanelAction } from '../../src/shared/ipc';

const peer = '0123456789abcdef';

describe('parsePanelAction', () => {
  it('accepts only well-formed panel actions', () => {
    expect(parsePanelAction({ t: 'alive', peer })).toEqual({ t: 'alive', peer });
    expect(parsePanelAction({ t: 'mute', peer, on: true })).toEqual({ t: 'mute', peer, on: true });
    expect(parsePanelAction({ t: 'kick', peer })).toEqual({ t: 'kick', peer });
    expect(parsePanelAction({ t: 'vote', kind: 'ff' })).toEqual({ t: 'vote', kind: 'ff' });
    expect(parsePanelAction({ t: 'vote', kind: 'ready' })).toEqual({ t: 'vote', kind: 'ready' });
    expect(parsePanelAction({ t: 'ballot', yes: false })).toEqual({ t: 'ballot', yes: false });
  });

  it('refuses anything that is not an object with a known type', () => {
    for (const raw of [null, undefined, 'alive', 7, [], {}, { t: 'quit' }, { t: 42 }]) expect(parsePanelAction(raw)).toBeNull();
  });

  it('refuses a peer that is not a 16-digit hex id', () => {
    for (const bad of ['', 'ABCDEF0123456789', '0123456789abcde', '0123456789abcdef0', 5, null]) {
      expect(parsePanelAction({ t: 'kick', peer: bad })).toBeNull();
      expect(parsePanelAction({ t: 'mute', peer: bad, on: true })).toBeNull();
      expect(parsePanelAction({ t: 'alive', peer: bad })).toBeNull();
    }
  });

  it('drops a point sent with an alive action, and refuses flags that are not booleans', () => {
    expect(parsePanelAction({ t: 'alive', peer, x: 10.5, y: 20 })).toEqual({ t: 'alive', peer });
    expect(parsePanelAction({ t: 'mute', peer, on: 1 })).toBeNull();
    expect(parsePanelAction({ t: 'ballot', yes: 'yes' })).toBeNull();
  });

  it('refuses a vote kind that panel cannot start, and keeps only the known fields', () => {
    expect(parsePanelAction({ t: 'vote', kind: 'kick' })).toBeNull();
    expect(parsePanelAction({ t: 'vote', kind: 'remake' })).toBeNull();
    expect(parsePanelAction({ t: 'ballot', yes: true, extra: 'x' })).toEqual({ t: 'ballot', yes: true });
  });
});

describe('OVERLAY_CHANNELS', () => {
  it('lists the mate channels', () => {
    expect(OVERLAY_CHANNELS).toEqual(
      expect.arrayContaining(['mate:clear', 'mate:fade', 'mate:ticket', 'mate:said', 'mate:glow']),
    );
  });
});

describe('parseMateGlow', () => {
  const glow = { box: { x: 10.5, y: 20, w: 200, h: 24 }, color: 3, rgb: null, delay: 120 };

  it('validates a glow box', () => {
    expect(parseMateGlow(glow)).toEqual(glow);
    expect(parseMateGlow({ ...glow, rgb: [255, 128, 0], ticket: 't1', extra: 1 }))
      .toEqual({ ...glow, rgb: [255, 128, 0], ticket: 't1' });
    expect(parseMateGlow({ ...glow, box: { x: -40, y: -8, w: 1, h: 1 }, delay: 0 })).not.toBeNull();
    for (const box of [
      null, {}, { x: 0, y: 0, w: 0, h: 10 }, { x: 0, y: 0, w: 10, h: -1 }, { x: Number.NaN, y: 0, w: 10, h: 10 },
      { x: 0, y: '0', w: 10, h: 10 }, { x: 0, y: 0, w: Infinity, h: 10 }, { x: 0, y: 0, w: 100_000, h: 10 },
      { x: 1e9, y: 0, w: 10, h: 10 },
    ]) {
      expect(parseMateGlow({ ...glow, box }), JSON.stringify(box)).toBeNull();
    }
  });

  it('refuses a colour, delay or ticket it could not use', () => {
    for (const bad of [
      { color: -1 }, { color: 99 }, { color: '3' }, { rgb: [300, 0, 0] }, { rgb: 'red' }, { delay: -1 },
      { delay: 60_000 }, { delay: Number.NaN }, { ticket: 5 }, { ticket: 'x'.repeat(200) },
    ]) {
      expect(parseMateGlow({ ...glow, ...bad }), JSON.stringify(bad)).toBeNull();
    }
    for (const raw of [null, undefined, 'glow', 7, []]) expect(parseMateGlow(raw)).toBeNull();
  });
});

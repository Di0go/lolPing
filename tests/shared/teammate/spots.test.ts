import { describe, expect, it } from 'vitest';
import type { Spot } from '../../../src/shared/teammate/askMachine';
import { LOST_KEY_UP_MS, MAX_SPOTS, SpotCollector } from '../../../src/shared/teammate/spots';

const spot = (x: number, displayId = 1): Spot => ({ intent: 'missing', phys: { x, y: 100 }, displayId });

function setup() {
  let t = 10_000;
  return { c: new SpotCollector(() => t), advance: (ms: number) => { t += ms; } };
}

describe('SpotCollector', () => {
  it('collects spots while the key is held and sends them on the key-up', () => {
    const { c, advance } = setup();
    expect(c.add(spot(1), true)).toEqual({ t: 'wait', dueAt: 10_000 + LOST_KEY_UP_MS });
    advance(500);
    expect(c.add(spot(2), true)).toEqual({ t: 'wait', dueAt: 10_500 + LOST_KEY_UP_MS });
    expect(c.size).toBe(2);
    expect(c.keyUp()).toEqual([spot(1), spot(2)]);
    expect(c.size).toBe(0);
  });

  it('sends each release at once for a mouse ask key', () => {
    const { c } = setup();
    expect(c.add(spot(1), false)).toEqual({ t: 'send', spots: [spot(1)] });
    expect(c.add(spot(2), false)).toEqual({ t: 'send', spots: [spot(2)] });
    expect(c.size).toBe(0);
  });

  it('refuses a fifth spot and keeps the four', () => {
    const { c } = setup();
    for (let i = 0; i < MAX_SPOTS; i += 1) c.add(spot(i), true);
    expect(c.add(spot(9), true)).toEqual({ t: 'refused', why: 'full' });
    expect(c.keyUp()).toEqual([spot(0), spot(1), spot(2), spot(3)]);
  });

  it('refuses a spot on another display', () => {
    const { c } = setup();
    c.add(spot(1, 1), true);
    expect(c.add(spot(2, 2), true)).toEqual({ t: 'refused', why: 'display' });
    expect(c.keyUp()).toEqual([spot(1, 1)]);
  });

  it('does not move the due time for a refused spot', () => {
    const { c, advance } = setup();
    c.add(spot(1, 1), true);
    advance(2000);
    c.add(spot(2, 2), true);
    advance(1000);
    expect(c.due()).toEqual([spot(1, 1)]);
  });

  it('sends the spots 3 s after the last release when the key-up is lost', () => {
    const { c, advance } = setup();
    c.add(spot(1), true);
    advance(1000);
    c.add(spot(2), true);
    advance(LOST_KEY_UP_MS - 100);
    expect(c.due()).toBeNull();
    advance(100);
    expect(c.due()).toEqual([spot(1), spot(2)]);
    expect(c.size).toBe(0);
    expect(c.due()).toBeNull();
  });

  it('sends nothing on a key-up with no spots', () => {
    const { c } = setup();
    expect(c.keyUp()).toBeNull();
  });

  it('hands the spots to the words box and forgets them', () => {
    const { c, advance } = setup();
    c.add(spot(1), true);
    c.add(spot(2), true);
    expect(c.take()).toEqual([spot(1), spot(2)]);
    expect(c.size).toBe(0);
    expect(c.keyUp()).toBeNull();
    advance(LOST_KEY_UP_MS);
    expect(c.due()).toBeNull();
  });

  it('forgets everything on clear', () => {
    const { c } = setup();
    c.add(spot(1), true);
    c.clear();
    expect(c.size).toBe(0);
    expect(c.keyUp()).toBeNull();
  });
});

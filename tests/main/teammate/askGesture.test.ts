import { describe, expect, it } from 'vitest';
import { AskGesture } from '../../../src/main/teammate/askGesture';
import type { Spot } from '../../../src/shared/teammate/askMachine';

const spot = (intent: Spot['intent'], x: number, displayId = 1): Spot => ({ intent, phys: { x, y: 500 }, displayId });

function harness(opts: { held?: boolean } = {}) {
  let clock = 1000;
  const timers: Array<{ at: number; fn: () => void; live: boolean }> = [];
  const asks: Spot[][] = [];
  const words: Spot[][] = [];
  const notes: Array<[Spot, 'full' | 'display']> = [];
  const reads: Spot[][] = [];
  let drops = 0;
  const gesture = new AskGesture({
    now: () => clock,
    timer: (ms, fn) => {
      const t = { at: clock + ms, fn, live: true };
      timers.push(t);
      return () => {
        t.live = false;
      };
    },
    held: () => opts.held ?? true,
    ask: (spots) => void asks.push(spots),
    words: (spots) => void words.push(spots),
    note: (s, why) => void notes.push([s, why]),
    prepare: (spots) => void reads.push(spots),
    drop: () => {
      drops += 1;
    },
  });
  /** Moves the clock and fires the timers that come due on the way. */
  const advance = (ms: number): void => {
    clock += ms;
    for (const t of timers) {
      if (!t.live || t.at > clock) continue;
      t.live = false;
      t.fn();
    }
  };
  return { gesture, asks, words, notes, reads, drops: () => drops, advance };
}

describe('AskGesture', () => {
  it('asks once with every spot when the key comes up', () => {
    const h = harness();
    const a = spot('missing', 100);
    const b = spot('missing', 200);
    const c = spot('danger', 300);
    h.gesture.release(a);
    h.advance(500);
    h.gesture.release(b);
    h.gesture.release(c);
    expect(h.asks).toEqual([]);
    h.gesture.keyUp();
    expect(h.asks).toEqual([[a, b, c]]);
    // Neither a second key-up nor the lost key-up timer asks again.
    h.gesture.keyUp();
    h.advance(5000);
    expect(h.asks).toHaveLength(1);
  });

  it('asks at once for each release of a mouse ask key', () => {
    const h = harness({ held: false });
    const a = spot('missing', 100);
    const b = spot('danger', 200);
    h.gesture.release(a);
    h.gesture.release(b);
    expect(h.asks).toEqual([[a], [b]]);
    h.gesture.keyUp();
    h.advance(5000);
    expect(h.asks).toHaveLength(2);
  });

  it('asks after 3 s when the key-up never comes', () => {
    const h = harness();
    const a = spot('missing', 100);
    const b = spot('danger', 200);
    h.gesture.release(a);
    h.advance(2000);
    h.gesture.release(b);
    // The 3 s run from the last release.
    h.advance(2999);
    expect(h.asks).toEqual([]);
    h.advance(1);
    expect(h.asks).toEqual([[a, b]]);
    h.gesture.keyUp(); // the up comes late after all: it asks nothing more
    expect(h.asks).toHaveLength(1);
  });

  it('opens the words box with the held spots and the click', () => {
    const h = harness();
    const a = spot('missing', 100);
    const click = spot('generic', 200);
    h.gesture.release(a);
    h.gesture.click(click);
    expect(h.words).toEqual([[a, click]]);
    // The words send the ask: the key-up and the lost key-up timer do nothing.
    h.gesture.keyUp();
    h.advance(5000);
    expect(h.asks).toEqual([]);

    // A click with nothing held opens the box with the click alone.
    h.gesture.click(click);
    expect(h.words).toEqual([[a, click], [click]]);
  });

  it('notes a fifth spot and a spot on another screen', () => {
    const h = harness();
    const four = [100, 200, 300, 400].map((x) => spot('missing', x));
    const other = spot('missing', 500, 2);
    h.gesture.release(four[0]);
    h.gesture.release(other);
    for (const s of four.slice(1)) h.gesture.release(s);
    const fifth = spot('danger', 600);
    h.gesture.release(fifth);
    h.gesture.keyUp();
    expect(h.notes).toEqual([[other, 'display'], [fifth, 'full']]);
    expect(h.asks).toEqual([four]);
  });

  it('opens the words box with the held spots when the click\'s own spot is refused', () => {
    const h = harness();
    const four = [100, 200, 300, 400].map((x) => spot('missing', x));
    for (const s of four) h.gesture.release(s);
    const click = spot('generic', 700);
    h.gesture.click(click); // a fifth spot: noted, and the box opens with the four
    expect(h.notes).toEqual([[click, 'full']]);
    expect(h.words).toEqual([four]);
    h.gesture.keyUp();
    h.advance(5000);
    expect(h.asks).toEqual([]);

    // A click on another screen than the held spot.
    const a = spot('missing', 100);
    const away = spot('generic', 200, 2);
    h.gesture.release(a);
    h.gesture.click(away);
    expect(h.notes).toEqual([[click, 'full'], [away, 'display']]);
    expect(h.words).toEqual([four, [a]]);
  });

  it('drops held spots on cancel', () => {
    const h = harness();
    h.gesture.release(spot('missing', 100));
    h.gesture.release(spot('missing', 200));
    h.gesture.cancel();
    h.gesture.keyUp();
    h.advance(5000);
    expect(h.asks).toEqual([]);
    // The next gesture starts empty.
    const c = spot('danger', 300);
    h.gesture.release(c);
    h.gesture.keyUp();
    expect(h.asks).toEqual([[c]]);
  });

  it('reads ahead at each held release with every spot so far', () => {
    const h = harness();
    const a = spot('missing', 100);
    const b = spot('danger', 200);
    h.gesture.release(a);
    h.gesture.release(b);
    expect(h.reads).toEqual([[a], [a, b]]);
    // A refused spot leaves the read as it is.
    h.gesture.release(spot('missing', 300, 2));
    expect(h.reads).toHaveLength(2);
    h.gesture.keyUp();
    expect(h.asks).toEqual([[a, b]]);
    expect(h.drops()).toBe(0); // the ask takes the read over
  });

  it('drops the read when the gesture is cancelled', () => {
    const h = harness();
    h.gesture.release(spot('missing', 100));
    h.gesture.cancel();
    expect(h.drops()).toBe(1);
    h.gesture.keyUp();
    expect(h.asks).toEqual([]);
  });

  it('never reads ahead for a mouse ask key or a click', () => {
    const mouse = harness({ held: false });
    mouse.gesture.release(spot('missing', 100));
    expect(mouse.asks).toHaveLength(1);
    expect(mouse.reads).toEqual([]);

    const h = harness();
    h.gesture.click(spot('generic', 100));
    expect(h.words).toHaveLength(1);
    expect(h.reads).toEqual([]);
    // The words box reads when its words are sent: a read made for the held spots goes.
    h.gesture.release(spot('missing', 200));
    h.gesture.click(spot('generic', 300));
    expect(h.reads).toHaveLength(1);
    expect(h.drops()).toBe(1);
  });
});

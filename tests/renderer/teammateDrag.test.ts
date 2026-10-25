import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PointerEvent } from 'react';
import type { MateDrag } from '../../src/shared/teammateIpc';
import { dragHandle } from '../../src/renderer/teammate/drag';

class FakeElement {
  constructor(private readonly handle: boolean) {}
  closest(): FakeElement | null {
    return this.handle ? null : this;
  }
}

const g = globalThis as { Element?: unknown };
let saved: unknown;
beforeEach(() => {
  saved = g.Element;
  g.Element = FakeElement;
});
afterEach(() => {
  g.Element = saved;
});

function event(x: number, y: number, opts: { button?: number; handle?: boolean } = {}): PointerEvent {
  const captured: number[] = [];
  return {
    button: opts.button ?? 0, screenX: x, screenY: y, pointerId: 1,
    target: new FakeElement(opts.handle ?? true),
    currentTarget: { setPointerCapture: (id: number) => captured.push(id) },
  } as unknown as PointerEvent;
}

describe('dragHandle', () => {
  it('sends the offset from where the press began, until the press ends', () => {
    const sent: MateDrag[] = [];
    const h = dragHandle((d) => sent.push(d));
    h.onPointerDown(event(100, 100));
    h.onPointerMove(event(130, 90));
    h.onPointerUp(event(160, 120));
    h.onPointerMove(event(200, 200));
    h.onLostPointerCapture(event(200, 200));
    expect(sent).toEqual([
      { phase: 'start', dx: 0, dy: 0 }, { phase: 'move', dx: 30, dy: -10 }, { phase: 'end', dx: 60, dy: 20 },
    ]);
  });

  it('leaves a press on a button, link or text box, and a right click, to the element', () => {
    const sent: MateDrag[] = [];
    const h = dragHandle((d) => sent.push(d));
    h.onPointerDown(event(100, 100, { handle: false }));
    h.onPointerDown(event(100, 100, { button: 2 }));
    h.onPointerMove(event(130, 90));
    expect(sent).toEqual([]);
  });
});

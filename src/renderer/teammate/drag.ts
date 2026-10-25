import type { PointerEvent } from 'react';
import type { MateDrag } from '../../shared/teammateIpc';

/** What a press on the drag handle doesn't start: its buttons, links and text boxes keep their own clicks. */
const NOT_A_HANDLE = 'button, a, input, textarea, [role="link"]';

/**
 * Pointer handlers that drag the bubble or card by `send`ing the pointer's offset from where the press began. The
 * pointer is captured, so the drag goes on outside the window and while the window moves under it.
 */
export function dragHandle(send: (d: MateDrag) => void) {
  let from: { x: number; y: number } | null = null;
  const offset = (e: PointerEvent): { dx: number; dy: number } =>
    (from ? { dx: e.screenX - from.x, dy: e.screenY - from.y } : { dx: 0, dy: 0 });
  const end = (e: PointerEvent): void => {
    if (!from) return;
    send({ phase: 'end', ...offset(e) });
    from = null;
  };
  return {
    onPointerDown(e: PointerEvent): void {
      if (e.button !== 0 || (e.target instanceof Element && e.target.closest(NOT_A_HANDLE))) return;
      e.currentTarget.setPointerCapture(e.pointerId);
      from = { x: e.screenX, y: e.screenY };
      send({ phase: 'start', dx: 0, dy: 0 });
    },
    onPointerMove(e: PointerEvent): void {
      if (from) send({ phase: 'move', ...offset(e) });
    },
    onPointerUp: end,
    onLostPointerCapture: end,
  };
}

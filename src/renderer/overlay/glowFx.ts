import type { MateGlow } from '../../shared/ipc';
import { tagColorCss } from '../../shared/roomColors';

/** How long a field's outline stays: it fades over this time, or holds still for it with reduced motion (the CSS). */
export const GLOW_MS = 900;

/** Outlines a field the teammate just wrote. One of its marks, so mate:clear and mate:fade take it too. */
export function spawnGlow(layer: HTMLElement, g: MateGlow): void {
  const el = document.createElement('div');
  el.className = 'mate-glow';
  el.dataset.owner = 'mate';
  el.style.left = `${g.box.x}px`;
  el.style.top = `${g.box.y}px`;
  el.style.width = `${g.box.w}px`;
  el.style.height = `${g.box.h}px`;
  el.style.setProperty('--glow', tagColorCss(g.color, g.rgb));
  layer.append(el);
  setTimeout(() => el.remove(), GLOW_MS);
}

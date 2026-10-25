import type { Point } from '../ipc';
import { overviewToPhysical, type Rect, type Shot } from './coords';
import type { Target } from './tools';

export type MarkKind = 'text' | 'button' | 'link' | 'field' | 'menu' | 'tab' | 'check' | 'item' | 'other';
/** A rectangle in physical screen pixels. */

export interface RawMark {
  kind: MarkKind;
  box: Rect;
  text: string;
}

/** Marks are context and snap targets, not something the model names, so they carry no id. */
export type Mark = RawMark;

const KINDS: readonly MarkKind[] = ['text', 'button', 'link', 'field', 'menu', 'tab', 'check', 'item', 'other'];
const MAX_TEXT = 120;
const ROW_PX = 20;

const isKind = (v: string): v is MarkKind => (KINDS as readonly string[]).includes(v);

/** Parses the context helper's marks file: one `kind\tx\ty\tw\th\ttext` line per mark. Bad lines are skipped. */
export function parseMarksFile(text: string): RawMark[] {
  const out: RawMark[] = [];
  for (const line of text.split('\n')) {
    const parts = line.replace(/\r$/, '').split('\t');
    if (parts.length < 6) continue;
    const [kind, ...rest] = parts;
    const [x, y, w, h] = rest.slice(0, 4).map((v) => (v.trim() === '' ? Number.NaN : Number(v)));
    if (![x, y, w, h].every(Number.isFinite) || w <= 0 || h <= 0) continue;
    const label = [...rest.slice(4).join(' ').trim()].slice(0, MAX_TEXT).join('').trim();
    out.push({ kind: isKind(kind) ? kind : 'other', box: { x, y, w, h }, text: label });
  }
  return out;
}

const isControl = (m: Mark): boolean => m.kind !== 'text';
/** Larger controls (a compose box, a list, a pane) hold words and spots of their own; their centre means nothing. */
const SNAP_MAX_W = 400;
const SNAP_MAX_H = 120;
/** A control a point may jump to the centre of: small, and not an image or container (`other`). */
const isSnapTarget = (m: Mark): boolean => (
  isControl(m) && m.kind !== 'other' && m.box.w <= SNAP_MAX_W && m.box.h <= SNAP_MAX_H
);

/** Distance from `p` to the nearest point of `box`; 0 inside or on its edge. */
function distanceTo(p: Point, box: Rect): number {
  const dx = Math.max(box.x - p.x, 0, p.x - (box.x + box.w));
  const dy = Math.max(box.y - p.y, 0, p.y - (box.y + box.h));
  return Math.hypot(dx, dy);
}

const centre = (box: Rect): Point => ({ x: Math.round(box.x + box.w / 2), y: Math.round(box.y + box.h / 2) });
const area = (box: Rect): number => box.w * box.h;

const sameText = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();
const inside = (inner: Rect, outer: Rect): boolean => (
  inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.w <= outer.x + outer.w && inner.y + inner.h <= outer.y + outer.h
);

/**
 * The marks worth showing the model: near a spot, without a text mark that only repeats the label of the control
 * around it, the nearest `max` of them, in reading order. With no spots nothing is near, so nothing is kept.
 */
export function selectMarks(
  raw: readonly RawMark[],
  spots: readonly Point[],
  opts: { radius?: number; max?: number } = {},
): Mark[] {
  const radius = opts.radius ?? 600;
  const max = opts.max ?? 150;
  const near: { mark: Mark; dist: number; at: number }[] = [];
  raw.forEach((mark, at) => {
    const dist = Math.min(...spots.map((s) => distanceTo(s, mark.box)));
    if (dist <= radius) near.push({ mark, dist, at });
  });
  const controls = near.filter((n) => isControl(n.mark));
  const kept = near.filter((n) => (
    isControl(n.mark) || !controls.some((c) => sameText(c.mark.text, n.mark.text) && inside(n.mark.box, c.mark.box))
  ));
  kept.sort((a, b) => a.dist - b.dist || a.at - b.at);
  const row = (m: Mark): number => Math.floor((m.box.y + m.box.h / 2) / ROW_PX);
  return kept.slice(0, max).map((n) => n.mark).sort((a, b) => (
    row(a) - row(b) || a.box.x + a.box.w / 2 - (b.box.x + b.box.w / 2)
  ));
}

/**
 * Moves a point the model picked by eye onto what it meant: the centre of the small control it is on or just beside,
 * else the middle of the text line it is on or just above or below (keeping x, so a word in a line stays put).
 */
export function snapPoint(
  p: Point,
  marks: readonly Mark[],
  opts: { controlPx?: number; linePx?: number } = {},
): Point {
  const controlPx = opts.controlPx ?? 24;
  const linePx = opts.linePx ?? 12;
  const controls = marks.filter(isSnapTarget);

  const on = controls.filter((m) => distanceTo(p, m.box) === 0);
  if (on.length > 0) return centre(on.reduce((a, b) => (area(b.box) < area(a.box) ? b : a)).box);

  let nearest: Mark | null = null;
  let best = Infinity;
  for (const m of controls) {
    const d = distanceTo(p, m.box);
    if (d < best) { best = d; nearest = m; }
  }
  if (nearest && best <= controlPx) return centre(nearest.box);

  let line: Mark | null = null;
  let lineDist = Infinity;
  for (const m of marks) {
    if (isControl(m) || p.x < m.box.x || p.x > m.box.x + m.box.w) continue;
    const d = Math.max(m.box.y - p.y, 0, p.y - (m.box.y + m.box.h));
    if (d <= linePx && d < lineDist) { lineDist = d; line = m; }
  }
  return line ? { x: p.x, y: Math.round(line.box.y + line.box.h / 2) } : p;
}

/** The screen point a tool call's target means; null for a spot that does not exist or a point off the screen. */
export function resolveTarget(
  at: Target,
  ctx: { spots: readonly Point[]; marks: readonly Mark[]; shot: Shot },
): Point | null {
  if ('spot' in at) return ctx.spots[at.spot - 1] ?? null;
  const phys = overviewToPhysical(ctx.shot, at);
  return phys ? snapPoint(phys, ctx.marks) : null;
}

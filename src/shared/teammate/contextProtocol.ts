import type { Point } from '../ipc';
import type { Shot } from './coords';

/** The overview's long side, its JPEG quality and the zoom crop size (spec §6.1). */
export const OVERVIEW_LONG_SIDE = 1600;
export const JPEG_QUALITY = 80;
export const ZOOM_SIZE = { w: 1000, h: 750 };

type Rect = Shot['display'];

/** Lines main writes to context-helper's stdin: flat JSON, lists as strings, like the hook helper's commands. */
export type ContextCommand =
  | {
    type: 'capture'; id: string; display: string; spots: string; overview: number; zoom: string; quality: number; dir: string;
  }
  | {
    type: 'marks'; id: string; of: string; spots: string; radius: number; ocr: boolean; controls: boolean; dir: string;
  }
  | { type: 'systemText'; id: string; spots: string }
  | { type: 'fileOf'; id: string }
  | { type: 'foreground'; id: string }
  | { type: 'ping'; id: string }
  | { type: 'shutdown' };

/** `slow`: an OS probe ran over its budget and the helper exits after this reply. */
export type ContextErrorCode = 'capture' | 'permission' | 'bad' | 'slow';

/** How the helper found the file behind the window. */
export type FileHow = 'office' | 'address' | 'title' | 'none';

/** What the system says is selected, under the spots and in focus. A secure field's value is always ''. */
export interface SystemTextLayer {
  selection: string;
  spotTexts: string[];
  focus: { kind: string; label: string; value: string; secure: boolean } | null;
  address: string;
}

/** Lines context-helper writes to stdout, after validation. */
export type ContextReply =
  | { type: 'captured'; id: string; overview: string; ow: number; oh: number; zooms: { path: string; rect: Rect }[] }
  /** `exiting`: a probe ran over its budget, so these are the marks the others found and the helper exits after. */
  | { type: 'marks'; id: string; path: string; count: number; exiting: boolean }
  | { type: 'systemText'; id: string; layer: SystemTextLayer }
  | { type: 'fileOf'; id: string; path: string; address: string; how: FileHow }
  | { type: 'foreground'; id: string; app: string; title: string }
  | { type: 'pong'; id: string }
  | { type: 'error'; id: string; code: ContextErrorCode; message: string };

const rectText = (r: Rect): string => [r.x, r.y, r.w, r.h].map(Math.round).join(',');
const spotsText = (spots: readonly Point[]): string => (
  spots.map((p) => `${Math.round(p.x)},${Math.round(p.y)}`).join(';')
);

/** The capture command for one ask: the helper wants whole pixels. */
export function captureCommand(
  id: string,
  req: { display: Rect; spots: { x: number; y: number }[]; dir: string },
): ContextCommand {
  return {
    type: 'capture',
    id,
    display: rectText(req.display),
    spots: spotsText(req.spots),
    overview: OVERVIEW_LONG_SIDE,
    zoom: `${ZOOM_SIZE.w},${ZOOM_SIZE.h}`,
    quality: JPEG_QUALITY,
    dir: req.dir,
  };
}

/** Reads text and controls near the spots from capture `of`'s grab into a marks file in `dir`. */
export function marksCommand(
  id: string,
  req: { of: string; spots: Point[]; radius: number; ocr: boolean; controls: boolean; dir: string },
): ContextCommand {
  return {
    type: 'marks', id, of: req.of, spots: spotsText(req.spots), radius: Math.round(req.radius), ocr: req.ocr,
    controls: req.controls, dir: req.dir,
  };
}

export const systemTextCommand = (id: string, spots: Point[]): ContextCommand => (
  { type: 'systemText', id, spots: spotsText(spots) }
);

export const fileOfCommand = (id: string): ContextCommand => ({ type: 'fileOf', id });

export const serializeContextCommand = (cmd: ContextCommand): string => `${JSON.stringify(cmd)}\n`;

const isPositiveInt = (v: unknown): v is number => Number.isInteger(v) && (v as number) > 0;
const isCount = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0;
const isErrorCode = (v: unknown): v is ContextErrorCode => (
  v === 'capture' || v === 'permission' || v === 'bad' || v === 'slow'
);
const isFileHow = (v: unknown): v is FileHow => v === 'office' || v === 'address' || v === 'title' || v === 'none';

/** Between spot texts in the systemText reply. */
const RECORD_SEPARATOR = '\u001e';

/** The helper's caps (kSelectionMax and the rest in context.h), applied again here in case a helper ever doesn't. */
const SELECTION_MAX = 4000;
const SPOT_TEXT_MAX = 2000;
const FOCUS_VALUE_MAX = 2000;
const ADDRESS_MAX = 2000;

/** The first `max` code points of `text`. */
function capChars(text: string, max: number): string {
  if (text.length <= max) return text;
  let at = 0;
  let n = 0;
  for (const ch of text) {
    if (n === max) return text.slice(0, at);
    at += ch.length;
    n += 1;
  }
  return text;
}

function parseSystemText(o: Record<string, unknown>): SystemTextLayer | null {
  const { selection, spotTexts, focusKind, focusLabel, focusValue, focusSecure, address } = o;
  if (typeof selection !== 'string' || typeof spotTexts !== 'string' || typeof focusKind !== 'string') return null;
  if (typeof focusLabel !== 'string' || typeof focusValue !== 'string' || typeof address !== 'string') return null;
  if (typeof focusSecure !== 'boolean') return null;
  // The helper already sends no value for a secure field; blanking it here keeps that true whatever arrives.
  const value = focusSecure ? '' : capChars(focusValue, FOCUS_VALUE_MAX);
  return {
    selection: capChars(selection, SELECTION_MAX),
    spotTexts: spotTexts === '' ? [] : spotTexts.split(RECORD_SEPARATOR).map((t) => capChars(t, SPOT_TEXT_MAX)),
    focus: focusKind === '' ? null : { kind: focusKind, label: focusLabel, value, secure: focusSecure },
    address: capChars(address, ADDRESS_MAX),
  };
}

function parseRect(s: string): Rect | null {
  const parts = s.split(',');
  if (parts.length !== 4 || parts.some((p) => !/^-?\d+$/.test(p))) return null;
  const [x, y, w, h] = parts.map(Number);
  return w > 0 && h > 0 ? { x, y, w, h } : null;
}

function parseZooms(paths: string, rects: string): { path: string; rect: Rect }[] | null {
  if (paths === '' && rects === '') return [];
  const ps = paths.split(';');
  const rs = rects.split(';');
  if (ps.length !== rs.length || ps.some((p) => p === '')) return null;
  const out: { path: string; rect: Rect }[] = [];
  for (let i = 0; i < ps.length; i += 1) {
    const rect = parseRect(rs[i]);
    if (!rect) return null;
    out.push({ path: ps[i], rect });
  }
  return out;
}

/** One stdout line, validated from unknown; null for anything malformed. */
export function parseContextLine(line: string): ContextReply | null {
  let v: unknown;
  try {
    v = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.id !== 'string') return null;
  const id = o.id;
  switch (o.type) {
    case 'captured': {
      if (typeof o.overview !== 'string' || o.overview === '' || !isPositiveInt(o.ow) || !isPositiveInt(o.oh)) return null;
      if (typeof o.zooms !== 'string' || typeof o.zoomRects !== 'string') return null;
      const zooms = parseZooms(o.zooms, o.zoomRects);
      return zooms ? { type: 'captured', id, overview: o.overview, ow: o.ow, oh: o.oh, zooms } : null;
    }
    case 'marks':
      if (typeof o.path !== 'string' || o.path === '' || !isCount(o.count)) return null;
      // Older helpers never send `exiting`.
      if (o.exiting !== undefined && typeof o.exiting !== 'boolean') return null;
      return { type: 'marks', id, path: o.path, count: o.count, exiting: o.exiting === true };
    case 'systemText': {
      const layer = parseSystemText(o);
      return layer ? { type: 'systemText', id, layer } : null;
    }
    case 'fileOf':
      if (typeof o.path !== 'string' || typeof o.address !== 'string' || !isFileHow(o.how)) return null;
      return { type: 'fileOf', id, path: o.path, address: o.address, how: o.how };
    case 'foreground':
      if (typeof o.app !== 'string' || typeof o.title !== 'string') return null;
      return { type: 'foreground', id, app: o.app, title: o.title };
    case 'pong':
      return { type: 'pong', id };
    case 'error':
      if (!isErrorCode(o.code) || typeof o.message !== 'string') return null;
      return { type: 'error', id, code: o.code, message: o.message };
    default:
      return null;
  }
}

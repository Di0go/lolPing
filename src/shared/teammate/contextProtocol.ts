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
  | { type: 'foreground'; id: string }
  | { type: 'ping'; id: string }
  | { type: 'shutdown' };

export type ContextErrorCode = 'capture' | 'permission' | 'bad';

/** Lines context-helper writes to stdout, after validation. */
export type ContextReply =
  | { type: 'captured'; id: string; overview: string; ow: number; oh: number; zooms: { path: string; rect: Rect }[] }
  | { type: 'foreground'; id: string; app: string; title: string }
  | { type: 'pong'; id: string }
  | { type: 'error'; id: string; code: ContextErrorCode; message: string };

const rectText = (r: Rect): string => [r.x, r.y, r.w, r.h].map(Math.round).join(',');

/** The capture command for one ask: the helper wants whole pixels. */
export function captureCommand(
  id: string,
  req: { display: Rect; spots: { x: number; y: number }[]; dir: string },
): ContextCommand {
  return {
    type: 'capture',
    id,
    display: rectText(req.display),
    spots: req.spots.map((p) => `${Math.round(p.x)},${Math.round(p.y)}`).join(';'),
    overview: OVERVIEW_LONG_SIDE,
    zoom: `${ZOOM_SIZE.w},${ZOOM_SIZE.h}`,
    quality: JPEG_QUALITY,
    dir: req.dir,
  };
}

export const serializeContextCommand = (cmd: ContextCommand): string => `${JSON.stringify(cmd)}\n`;

const isPositiveInt = (v: unknown): v is number => Number.isInteger(v) && (v as number) > 0;
const isErrorCode = (v: unknown): v is ContextErrorCode => v === 'capture' || v === 'permission' || v === 'bad';

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

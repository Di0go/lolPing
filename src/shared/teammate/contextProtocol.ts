import type { Point } from '../ipc';
import type { Rect } from './coords';
import { neverFill, type FormField } from './doRules';

/** The overview's long side, its JPEG quality and the zoom crop size (spec §6.1). */
export const OVERVIEW_LONG_SIDE = 1600;
export const JPEG_QUALITY = 80;
export const ZOOM_SIZE = { w: 1000, h: 750 };

/** Lines main writes to context-helper's stdin: flat JSON, lists as strings, like the hook helper's commands. */
export type ContextCommand =
  | {
    type: 'capture'; id: string; display: string; area?: string; spots: string; crops?: string; overview: number;
    zoom: string; quality: number; dir: string;
  }
  | {
    type: 'read'; id: string; spots: string; radius: number; marks: boolean; text: boolean; file: boolean;
    boxes: boolean; fields: boolean; dir: string;
  }
  | { type: 'foreground'; id: string }
  | { type: 'ping'; id: string }
  | { type: 'shutdown' };

export type ContextErrorCode = 'capture' | 'permission' | 'bad';

/** One layer of a read: `off` was not asked for; `slow` was still running at the budget, so the helper exits. */
export type LayerStatus = 'off' | 'ok' | 'slow' | 'capture' | 'permission';

/** How the helper found the file behind the window. */
export type FileHow = 'office' | 'address' | 'title' | 'none';

/** What the system says is selected, under the spots and in focus. A secure field's value is always ''. */
export interface SystemTextLayer {
  selection: string;
  spotTexts: string[];
  focus: { kind: string; label: string; value: string; secure: boolean } | null;
  address: string;
}

/** What one read found; a layer is null unless its status is `ok`. */
export interface ReadResult {
  status: { marks: LayerStatus; text: LayerStatus; file: LayerStatus; boxes: LayerStatus; fields: LayerStatus };
  marks: { path: string; count: number } | null;
  text: SystemTextLayer | null;
  file: { path: string; address: string; how: FileHow } | null;
  /** Per spot, the boxes that hold the element under it, innermost first, ending with its window. */
  boxes: Rect[][] | null;
  /** The form fields in the window, in a JSON-lines file (see parseFieldsFile). */
  fields: { path: string; count: number } | null;
}

/** Lines context-helper writes to stdout, after validation. */
export type ContextReply =
  | { type: 'captured'; id: string; overview: string; ow: number; oh: number; zooms: { path: string; rect: Rect }[] }
  | ({ type: 'read'; id: string } & ReadResult)
  /** `window` is the window's id (the HWND in decimal on Windows), or '' where the helper has none. */
  | { type: 'foreground'; id: string; app: string; title: string; window: string }
  | { type: 'pong'; id: string }
  | { type: 'error'; id: string; code: ContextErrorCode; message: string };

const rectText = (r: Rect): string => [r.x, r.y, r.w, r.h].map(Math.round).join(',');
const spotsText = (spots: readonly Point[]): string => (
  spots.map((p) => `${Math.round(p.x)},${Math.round(p.y)}`).join(';')
);

/**
 * The capture command for one ask: the helper wants whole pixels. The overview shows `area` (the whole display when
 * left out); each spot's close-up is its crop, or a fixed-size one around it.
 */
export function captureCommand(
  id: string,
  req: { display: Rect; area?: Rect; spots: { x: number; y: number }[]; crops?: Rect[]; dir: string },
): ContextCommand {
  return {
    type: 'capture',
    id,
    display: rectText(req.display),
    ...(req.area ? { area: rectText(req.area) } : {}),
    spots: spotsText(req.spots),
    ...(req.crops ? { crops: req.crops.map(rectText).join(';') } : {}),
    overview: OVERVIEW_LONG_SIDE,
    zoom: `${ZOOM_SIZE.w},${ZOOM_SIZE.h}`,
    quality: JPEG_QUALITY,
    dir: req.dir,
  };
}

/**
 * Reads the layers that are on, side by side: the boxes around the element under each spot, the controls and text
 * near the spots (into a marks file in `dir`), the system text, the file behind the window and the form fields
 * (into a fields file in `dir`).
 */
export function readCommand(
  id: string,
  req: {
    spots: Point[]; radius: number; marks: boolean; text: boolean; file: boolean; boxes: boolean; fields: boolean;
    dir: string;
  },
): ContextCommand {
  return {
    type: 'read', id, spots: spotsText(req.spots), radius: Math.round(req.radius), marks: req.marks, text: req.text,
    file: req.file, boxes: req.boxes, fields: req.fields, dir: req.dir,
  };
}

export const serializeContextCommand = (cmd: ContextCommand): string => `${JSON.stringify(cmd)}\n`;

const isPositiveInt = (v: unknown): v is number => Number.isInteger(v) && (v as number) > 0;
const isCount = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0;
const isErrorCode = (v: unknown): v is ContextErrorCode => v === 'capture' || v === 'permission' || v === 'bad';
const isLayerStatus = (v: unknown): v is LayerStatus => (
  v === 'off' || v === 'ok' || v === 'slow' || v === 'capture' || v === 'permission'
);
const isFileHow = (v: unknown): v is FileHow => v === 'office' || v === 'address' || v === 'title' || v === 'none';

/** Between spot texts in the read reply. */
const RECORD_SEPARATOR = '\u001e';

/** The helper's caps (kSelectionMax and the rest in context.h), applied again here in case a helper ever doesn't. */
const SELECTION_MAX = 4000;
const SPOT_TEXT_MAX = 2000;
const FOCUS_VALUE_MAX = 2000;
const ADDRESS_MAX = 2000;

/** The helper's caps on the form fields file (kMaxFormFields and the rest in context.h), applied again here. */
const FIELDS_MAX = 60;
const FIELD_ID_MAX = 120;
const FIELD_LABEL_MAX = 120;
const FIELD_VALUE_MAX = 2000;
const FIELD_OPTIONS_MAX = 50;
const FIELD_OPTION_MAX = 120;
const FIELD_KINDS: readonly FormField['kind'][] = ['text', 'multiline', 'combo', 'checkbox', 'radio', 'other'];

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

function parseField(v: unknown): FormField | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const { id, kind, label, group, value, secure, required, options } = o;
  if (typeof id !== 'string' || id === '' || typeof kind !== 'string') return null;
  if (!FIELD_KINDS.includes(kind as FormField['kind'])) return null;
  if (typeof label !== 'string' || typeof group !== 'string' || typeof value !== 'string') return null;
  if (typeof secure !== 'boolean' || typeof required !== 'boolean' || !Array.isArray(options)) return null;
  if (!options.every((opt) => typeof opt === 'string')) return null;
  return {
    id: capChars(id, FIELD_ID_MAX),
    kind: kind as FormField['kind'],
    label: capChars(label, FIELD_LABEL_MAX),
    group: capChars(group, FIELD_LABEL_MAX),
    // The helper already sends no value for a secure or never-fill field; blanking it here keeps that true whatever
    // arrives.
    value: neverFill({ label, secure }) ? '' : capChars(value, FIELD_VALUE_MAX),
    secure,
    required,
    options: (options as string[]).slice(0, FIELD_OPTIONS_MAX).map((opt) => capChars(opt, FIELD_OPTION_MAX)),
  };
}

/**
 * The helper's fields file: one JSON object per line, one form field each. A line that is not a valid field is
 * skipped, as is a repeated id, and at most 60 fields are kept.
 */
export function parseFieldsFile(text: string): FormField[] {
  const out: FormField[] = [];
  const seen = new Set<string>();
  for (const line of text.split('\n')) {
    if (out.length === FIELDS_MAX) break;
    if (line.trim() === '') continue;
    let v: unknown;
    try {
      v = JSON.parse(line);
    } catch {
      continue;
    }
    const field = parseField(v);
    if (!field || seen.has(field.id)) continue;
    seen.add(field.id);
    out.push(field);
  }
  return out;
}

function parseRead(o: Record<string, unknown>): ReadResult | null {
  const { marks, text, file, boxes, fields } = o;
  if (!isLayerStatus(marks) || !isLayerStatus(text) || !isLayerStatus(file) || !isLayerStatus(boxes)) return null;
  if (!isLayerStatus(fields)) return null;
  let found: ReadResult['marks'] = null;
  if (marks === 'ok') {
    if (typeof o.marksPath !== 'string' || o.marksPath === '' || !isCount(o.count)) return null;
    found = { path: o.marksPath, count: o.count };
  }
  const layer = text === 'ok' ? parseSystemText(o) : null;
  if (text === 'ok' && !layer) return null;
  let behind: ReadResult['file'] = null;
  if (file === 'ok') {
    if (typeof o.filePath !== 'string' || typeof o.fileAddress !== 'string' || !isFileHow(o.how)) return null;
    behind = { path: o.filePath, address: o.fileAddress, how: o.how };
  }
  let chains: ReadResult['boxes'] = null;
  if (boxes === 'ok') {
    chains = typeof o.boxRects === 'string' ? parseBoxes(o.boxRects) : null;
    if (!chains) return null;
  }
  let form: ReadResult['fields'] = null;
  if (fields === 'ok') {
    if (typeof o.fieldsPath !== 'string' || o.fieldsPath === '' || !isCount(o.fieldCount)) return null;
    form = { path: o.fieldsPath, count: o.fieldCount };
  }
  return {
    status: { marks, text, file, boxes, fields }, marks: found, text: layer, file: behind, boxes: chains, fields: form,
  };
}

function parseRect(s: string): Rect | null {
  const parts = s.split(',');
  if (parts.length !== 4 || parts.some((p) => !/^-?\d+$/.test(p))) return null;
  const [x, y, w, h] = parts.map(Number);
  return w > 0 && h > 0 ? { x, y, w, h } : null;
}

/** Spots separated by ';', each spot's boxes by '|'; a spot with no boxes is empty. */
function parseBoxes(s: string): Rect[][] | null {
  const out: Rect[][] = [];
  for (const spot of s.split(';')) {
    const chain = spot === '' ? [] : spot.split('|').map(parseRect);
    if (chain.some((r) => r === null)) return null;
    out.push(chain.filter((r): r is Rect => r !== null));
  }
  return out;
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
    case 'read': {
      const result = parseRead(o);
      return result ? { type: 'read', id, ...result } : null;
    }
    case 'foreground':
      if (typeof o.app !== 'string' || typeof o.title !== 'string') return null;
      if (typeof o.window !== 'string' || !/^[0-9]*$/.test(o.window)) return null;
      return { type: 'foreground', id, app: o.app, title: o.title, window: o.window };
    case 'pong':
      return { type: 'pong', id };
    case 'error':
      if (!isErrorCode(o.code) || typeof o.message !== 'string') return null;
      return { type: 'error', id, code: o.code, message: o.message };
    default:
      return null;
  }
}

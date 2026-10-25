import type { PingId } from '../pings';
import { EMOTE_CATALOG } from '../emoteCatalog';
import { DISPLAY_TOOLS } from './agents';
import { TABLE_MAX, eventIcs, normalizeTable, type EventFields } from './grab';
import type { IntentKind } from './intents';

/** Where the model points: one of the user's spots (numbered from 1), or overview pixels that lolPing snaps. */
export type Target = { spot: number } | { x: number; y: number };

export type ToolCall =
  | { tool: 'say'; text: string }
  | { tool: 'ping'; type: MatePing; at: Target; label?: string; order?: number }
  | { tool: 'emote'; slug: string; at: Target }
  | { tool: 'answer'; markdown: string }
  | { tool: 'look'; x: number; y: number; w: number; h: number }
  | { tool: 'read_file'; pages?: { from: number; to: number }; search?: string }
  | { tool: 'copy'; text: string }
  | { tool: 'copy'; table: string[][] }
  | ({ tool: 'event' } & EventFields)
  | { tool: 'paste'; text: string; mode: 'insert' | 'replace' }
  | { tool: 'fill'; fields: { id: string; value: string }[] }
  | { tool: 'open'; url: string };

/** The calls that put something into the user's world; the action runner carries them out after asking. */
export type ActionCall = Extract<ToolCall, { tool: 'copy' | 'event' | 'paste' | 'fill' | 'open' }>;

export interface ToolDef {
  name: string;
  description: string;
  /** JSON Schema. */
  parameters: Record<string, unknown>;
}

export const MAX_PINGS = 6;
export const MAX_EMOTES = 1;
const MAX_SAY = 600;
const MAX_ANSWER = 20_000;
const MAX_LABEL = 20;
const MAX_SEARCH = 200;
const MAX_COPY = 20_000;
const MAX_PASTE = 20_000;
const MAX_FILL_FIELDS = 60;
const MAX_FILL_VALUE = 2_000;
const MAX_EVENT_TITLE = 200;
const MAX_EVENT_LOCATION = 200;
const MAX_EVENT_NOTES = 2_000;
const MAX_URL = 2_000;
const MAX_OPENS = 3;

/** The pings the teammate may place. On My Way is lolPing's own receipt and Translate is not a ping meaning. */
export const MATE_PINGS = [
  'danger', 'assist', 'missing', 'needvision', 'push', 'allin', 'enemyvision', 'bait', 'visioncleared', 'generic',
] as const satisfies readonly PingId[];
export type MatePing = (typeof MATE_PINGS)[number];

const POINT_PROPS = {
  x: { type: 'number', description: 'Horizontal position in overview image pixels, on the exact element you mean.' },
  y: { type: 'number', description: 'Vertical position in overview image pixels, on the exact element you mean.' },
  spot: { type: 'integer', description: "Number of one of the user's spots, instead of x and y." },
};

export function toolDefs(opts: {
  emotes: boolean;
  spots: number;
  file: boolean;
  look: boolean;
  kind: IntentKind;
  /** Form fields were read, so `fill` has ids to use. */
  form: boolean;
  /** Text was selected at the ask: only then can a paste replace anything. */
  selection: boolean;
}): ToolDef[] {
  const spotNote = opts.spots > 0 ? ` The user marked ${opts.spots} spot${opts.spots === 1 ? '' : 's'}.` : '';
  const defs: ToolDef[] = [
    {
      name: 'say',
      description: 'Say one short line to the user in a speech bubble.',
      parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    },
    {
      name: 'ping',
      description: `Place a League ping on the screen at a point.${spotNote}`,
      parameters: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: MATE_PINGS },
          ...POINT_PROPS,
          label: { type: 'string', description: `A short label, at most ${MAX_LABEL} characters.` },
          order: { type: 'integer', description: 'Place pings with a lower order first.' },
        },
        required: ['type'],
      },
    },
  ];
  if (opts.emotes) {
    defs.push({
      name: 'emote',
      description: 'Show an emote at a point. Use at most one.',
      parameters: {
        type: 'object',
        properties: { slug: { type: 'string', enum: EMOTE_CATALOG.map((e) => e.slug) }, ...POINT_PROPS },
        required: ['slug'],
      },
    });
  }
  defs.push({
    name: 'answer',
    description: 'Give a longer answer in Markdown, shown in a card.',
    parameters: { type: 'object', properties: { markdown: { type: 'string' } }, required: ['markdown'] },
  });
  if (opts.look) {
    defs.push({
      name: 'look',
      description: "Get a closer, zoomed view of a rectangle of the overview, for a detail you can't read in the images.",
      parameters: {
        type: 'object',
        properties: {
          x: { type: 'number' },
          y: { type: 'number' },
          w: { type: 'number', description: 'Width in overview pixels.' },
          h: { type: 'number', description: 'Height in overview pixels.' },
        },
        required: ['x', 'y', 'w', 'h'],
      },
    });
  }
  if (opts.file) {
    defs.push({
      name: 'read_file',
      description: 'Read more of the open file: some pages, or the passages that match a search. Give one of the two.',
      parameters: {
        type: 'object',
        properties: {
          pages: { type: 'string', description: 'Pages to read, 1-based: "3" or "3-5".' },
          search: { type: 'string', description: `Words to look for in the file, at most ${MAX_SEARCH} characters.` },
        },
      },
    });
  }
  if (opts.kind === 'grab' || opts.kind === 'act') {
    defs.push({
      name: 'copy',
      description: 'Put text or a table on the clipboard at once. Give `text`, or `table` for a table.',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: `The exact text, at most ${MAX_COPY} characters.` },
          table: {
            type: 'array',
            description: `A table as rows of cells, at most ${TABLE_MAX.rows} rows of ${TABLE_MAX.cols} cells.`,
            items: { type: 'array', items: { type: 'string' } },
          },
        },
      },
    });
  }
  if (opts.kind === 'grab') {
    defs.push({
      name: 'event',
      description: 'Offer a calendar event for a date or an event on the screen, after the user agrees. Times are '
        + 'local, "YYYY-MM-DDTHH:mm". Give just a date, "YYYY-MM-DD", for an all-day event; then `end` is the last '
        + 'day of the event, inclusive.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: `At most ${MAX_EVENT_TITLE} characters.` },
          start: { type: 'string', description: '"YYYY-MM-DDTHH:mm", or "YYYY-MM-DD" for an all-day event.' },
          end: { type: 'string', description: 'The same format as start. Leave it out when the screen gives no end.' },
          location: { type: 'string', description: `At most ${MAX_EVENT_LOCATION} characters.` },
          notes: { type: 'string', description: `At most ${MAX_EVENT_NOTES} characters.` },
        },
        required: ['title', 'start'],
      },
    });
  }
  if (opts.kind === 'act') {
    defs.push({
      name: 'paste',
      description: 'Paste text into the text field or editor the user pinged, after the user agrees. Use at most one. '
        + 'An insert adds only the new text at the caret: never repeat text that is already there.',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: `The finished text, at most ${MAX_PASTE} characters.` },
          // With nothing selected a replace can only be copied instead, so the model isn't offered one.
          mode: opts.selection
            ? {
              type: 'string',
              enum: ['insert', 'replace'],
              description: '`insert` at the caret, or `replace` to overwrite the text that is selected.',
            }
            : { type: 'string', enum: ['insert'], description: 'Nothing is selected: the text goes in at the caret.' },
        },
        required: ['text', 'mode'],
      },
    });
  }
  if (opts.kind === 'act' && opts.form) {
    defs.push({
      name: 'fill',
      description: 'Fill form fields from the list of form fields; the user sees them first. Use at most one. A '
        + 'checkbox value is exactly `on` or `off`. A radio button is chosen by giving its id any value. Never fill a '
        + 'field marked "secure, never fill".',
      parameters: {
        type: 'object',
        properties: {
          fields: {
            type: 'array',
            description: `At most ${MAX_FILL_FIELDS} fields.`,
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', description: 'The id from the form fields list.' },
                value: { type: 'string', description: `At most ${MAX_FILL_VALUE} characters.` },
              },
              required: ['id', 'value'],
            },
          },
        },
        required: ['fields'],
      },
    });
  }
  defs.push({
    name: 'open',
    description: 'Open a web link in the browser, after the user agrees. Only http and https links.',
    parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
  });
  return defs;
}

/** What an agent that pings the user unprompted may call: lolPing places its marks at the cursor, so no position. */
export function visitorToolDefs(emotes: boolean): ToolDef[] {
  const shown = new Set<string>(DISPLAY_TOOLS);
  return toolDefs({ emotes, spots: 0, file: false, look: false, kind: 'answer', form: false, selection: false })
    .filter((d) => shown.has(d.name))
    .map((d) => {
      const { properties, ...rest } = d.parameters;
      if (!isRecord(properties)) return d;
      const { x: _x, y: _y, spot: _spot, ...kept } = properties;
      return { ...d, parameters: { ...rest, properties: kept } };
    });
}

/** Claude Code's `--permission-prompt-tool`: it asks here before it edits or runs anything. */
export const CONSENT_TOOL: ToolDef = {
  name: 'consent',
  description: "lolPing's permission prompt: Claude Code asks it before using a tool. The user decides on a card.",
  parameters: {
    type: 'object',
    properties: {
      tool_name: { type: 'string', description: 'The tool that wants to run.' },
      input: { type: 'object', description: 'The input the tool would run with.' },
      tool_use_id: { type: 'string' },
    },
    required: ['tool_name', 'input'],
  },
};

/** A tool name goes into a saved permission key, so only the characters a key can hold. */
const CONSENT_TOOL_NAME = /^[A-Za-z0-9_.-]{1,64}$/;

/** The tool and input of a permission prompt; null when the name can't be a permission key or input isn't an object. */
export function parseConsent(args: unknown): { tool: string; input: unknown } | null {
  if (!isRecord(args) || typeof args.tool_name !== 'string' || !CONSENT_TOOL_NAME.test(args.tool_name)) return null;
  return isRecord(args.input) ? { tool: args.tool_name, input: args.input } : null;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function text(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim().slice(0, max).trim();
  return t ? t : null;
}

function target(a: Record<string, unknown>): Target | null {
  const x = num(a.x);
  const y = num(a.y);
  if (x !== null && y !== null) return { x, y };
  // `mark` is what an earlier version called a spot; a model may copy it from a turn it has already seen.
  const spot = num(a.spot ?? a.mark);
  return spot !== null && Number.isInteger(spot) && spot >= 1 ? { spot } : null;
}

function pageRange(v: unknown): { from: number; to: number } | null {
  // The schema asks for a string, but models often send a single page as a number.
  if (typeof v === 'number') return Number.isInteger(v) && v >= 1 ? { from: v, to: v } : null;
  const m = typeof v === 'string' ? /^\s*(\d+)\s*(?:-\s*(\d+)\s*)?$/.exec(v) : null;
  if (!m) return null;
  const from = Number(m[1]);
  const to = m[2] === undefined ? from : Number(m[2]);
  return from >= 1 && from <= to ? { from, to } : null;
}

/** Text that must arrive as given, not trimmed or cut: null when blank, over the limit or not a string. */
function exactText(v: unknown, max: number): string | null {
  return typeof v === 'string' && v.trim() !== '' && v.length <= max ? v : null;
}

/** Trimmed text for an event field: undefined when absent or empty, null when over the limit or not a string. */
function optionalText(v: unknown, max: number): string | undefined | null {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') return null;
  const t = v.trim();
  if (t === '') return undefined;
  return t.length <= max ? t : null;
}

function fillFields(v: unknown): { id: string; value: string }[] | null {
  if (!Array.isArray(v) || v.length === 0 || v.length > MAX_FILL_FIELDS) return null;
  // The last value for an id wins; the Map keeps the id's first place in the list.
  const byId = new Map<string, string>();
  for (const f of v as unknown[]) {
    if (!isRecord(f) || typeof f.id !== 'string' || f.id === '') return null;
    const value = typeof f.value === 'number' && Number.isFinite(f.value) ? String(f.value) : f.value;
    if (typeof value !== 'string' || value.length > MAX_FILL_VALUE) return null;
    byId.set(f.id, value);
  }
  return [...byId].map(([id, value]) => ({ id, value }));
}

function eventCall(a: Record<string, unknown>): ToolCall | null {
  const title = optionalText(a.title, MAX_EVENT_TITLE);
  const end = optionalText(a.end, 40);
  const location = optionalText(a.location, MAX_EVENT_LOCATION);
  const notes = optionalText(a.notes, MAX_EVENT_NOTES);
  if (!title || typeof a.start !== 'string' || end === null || location === null || notes === null) return null;
  const event: EventFields = {
    title,
    start: a.start.trim(),
    ...(end !== undefined ? { end } : {}),
    ...(location !== undefined ? { location } : {}),
    ...(notes !== undefined ? { notes } : {}),
  };
  // eventIcs is the one judge of the dates (a real day, an end not before the start); the zone doesn't change that.
  return eventIcs(event, { uid: 'check', now: 0, zoneOffset: () => 0 }) === null ? null : { tool: 'event', ...event };
}

function webUrl(v: unknown): string | null {
  const t = typeof v === 'string' ? v.trim() : '';
  if (t === '' || t.length > MAX_URL) return null;
  try {
    const { protocol } = new URL(t);
    return protocol === 'http:' || protocol === 'https:' ? t : null;
  } catch {
    return null;
  }
}

/** Turns one model tool call into a ToolCall; anything malformed is null. */
export function parseToolCall(name: string, args: unknown): ToolCall | null {
  let a: unknown = args;
  if (typeof a === 'string') {
    try { a = JSON.parse(a); } catch { return null; }
  }
  if (!isRecord(a)) return null;
  switch (name) {
    case 'say': {
      const t = text(a.text, MAX_SAY);
      return t === null ? null : { tool: 'say', text: t };
    }
    case 'answer': {
      const t = text(a.markdown, MAX_ANSWER);
      return t === null ? null : { tool: 'answer', markdown: t };
    }
    case 'ping': {
      const type = MATE_PINGS.find((id) => id === a.type);
      const at = target(a);
      if (!type || !at) return null;
      const label = a.label === undefined ? null : text(a.label, MAX_LABEL);
      const order = a.order === undefined ? null : num(a.order);
      return {
        tool: 'ping', type, at,
        ...(label !== null ? { label } : {}),
        ...(order !== null ? { order } : {}),
      };
    }
    case 'emote': {
      const slug = EMOTE_CATALOG.find((e) => e.slug === a.slug)?.slug;
      const at = target(a);
      return slug && at ? { tool: 'emote', slug, at } : null;
    }
    case 'look': {
      const x = num(a.x);
      const y = num(a.y);
      const w = num(a.w);
      const h = num(a.h);
      if (x === null || y === null || w === null || h === null || w <= 0 || h <= 0) return null;
      return { tool: 'look', x, y, w, h };
    }
    case 'read_file': {
      const pages = pageRange(a.pages);
      const search = text(a.search, MAX_SEARCH);
      if (!pages && search === null) return null;
      return { tool: 'read_file', ...(pages ? { pages } : {}), ...(search !== null ? { search } : {}) };
    }
    case 'copy': {
      // A table wins when both come: a model may add the table's text as well.
      const table = a.table === undefined ? null : normalizeTable(a.table);
      if (table) return { tool: 'copy', table };
      const t = exactText(a.text, MAX_COPY);
      return t === null ? null : { tool: 'copy', text: t };
    }
    case 'paste': {
      const t = exactText(a.text, MAX_PASTE);
      const mode = a.mode === undefined ? 'insert' : a.mode;
      return t !== null && (mode === 'insert' || mode === 'replace') ? { tool: 'paste', text: t, mode } : null;
    }
    case 'fill': {
      const fields = fillFields(a.fields);
      return fields ? { tool: 'fill', fields } : null;
    }
    case 'event':
      return eventCall(a);
    case 'open': {
      const url = webUrl(a.url);
      return url === null ? null : { tool: 'open', url };
    }
    default:
      return null;
  }
}

/**
 * Keeps the first MAX_PINGS pings, MAX_EMOTES emote, one paste, one fill, one event and MAX_OPENS opens in arrival
 * order; every other call always stays.
 */
export function applyLimits(calls: readonly ToolCall[]): ToolCall[] {
  let pings = 0;
  let emotes = 0;
  let pastes = 0;
  let fills = 0;
  let events = 0;
  let opens = 0;
  return calls.filter((c) => {
    if (c.tool === 'ping') return pings++ < MAX_PINGS;
    if (c.tool === 'emote') return emotes++ < MAX_EMOTES;
    if (c.tool === 'paste') return pastes++ < 1;
    if (c.tool === 'fill') return fills++ < 1;
    if (c.tool === 'event') return events++ < 1;
    if (c.tool === 'open') return opens++ < MAX_OPENS;
    return true;
  });
}

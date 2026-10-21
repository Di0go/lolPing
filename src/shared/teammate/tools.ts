import type { PingId } from '../pings';
import { EMOTE_CATALOG } from '../emoteCatalog';

/** Where the model points: one of the user's spots (numbered from 1), or overview pixels that lolPing snaps. */
export type Target = { spot: number } | { x: number; y: number };

export type ToolCall =
  | { tool: 'say'; text: string }
  | { tool: 'ping'; type: MatePing; at: Target; label?: string; order?: number }
  | { tool: 'emote'; slug: string; at: Target }
  | { tool: 'answer'; markdown: string }
  | { tool: 'look'; x: number; y: number; w: number; h: number }
  | { tool: 'read_file'; pages?: { from: number; to: number }; search?: string };

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

export function toolDefs(opts: { emotes: boolean; spots: number; file: boolean }): ToolDef[] {
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
  defs.push(
    {
      name: 'answer',
      description: 'Give a longer answer in Markdown, shown in a card.',
      parameters: { type: 'object', properties: { markdown: { type: 'string' } }, required: ['markdown'] },
    },
    {
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
    },
  );
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
  return defs;
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
    default:
      return null;
  }
}

/** Keeps the first MAX_PINGS pings and MAX_EMOTES emote in arrival order; say and answer always stay. */
export function applyLimits(calls: readonly ToolCall[]): ToolCall[] {
  let pings = 0;
  let emotes = 0;
  return calls.filter((c) => {
    if (c.tool === 'ping') return pings++ < MAX_PINGS;
    if (c.tool === 'emote') return emotes++ < MAX_EMOTES;
    return true;
  });
}

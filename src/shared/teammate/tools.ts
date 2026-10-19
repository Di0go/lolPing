import type { PingId } from '../pings';
import { EMOTE_CATALOG } from '../emoteCatalog';

/** A spot the model points at: one of the user's marked spots, or overview pixels. */
export type Target = { mark: number } | { x: number; y: number };

export type ToolCall =
  | { tool: 'say'; text: string }
  | { tool: 'ping'; type: MatePing; at: Target; label?: string; order?: number }
  | { tool: 'emote'; slug: string; at: Target }
  | { tool: 'answer'; markdown: string }
  | { tool: 'look'; x: number; y: number; w: number; h: number };

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

/** The pings the teammate may place. On My Way is lolPing's own receipt and Translate is not a ping meaning. */
export const MATE_PINGS = [
  'danger', 'assist', 'missing', 'needvision', 'push', 'allin', 'enemyvision', 'bait', 'visioncleared', 'generic',
] as const satisfies readonly PingId[];
export type MatePing = (typeof MATE_PINGS)[number];

const POINT_PROPS = {
  x: { type: 'number', description: 'Horizontal position in overview image pixels.' },
  y: { type: 'number', description: 'Vertical position in overview image pixels.' },
  mark: { type: 'integer', description: "Number of one of the user's marked spots, instead of x and y." },
};

export function toolDefs(opts: { emotes: boolean; spots: number }): ToolDef[] {
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
      description: 'Get a closer, zoomed view of a rectangle of the overview.',
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
  if (a.x !== undefined || a.y !== undefined) {
    const x = num(a.x);
    const y = num(a.y);
    return x === null || y === null ? null : { x, y };
  }
  const mark = num(a.mark);
  return mark !== null && Number.isInteger(mark) && mark >= 0 ? { mark } : null;
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

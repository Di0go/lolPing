import type { ToolDef } from './tools';

/** The line format's version; the app compares it with `hello.v` and answers `bye` for a bridge it can't serve. */
export const BRIDGE_VERSION = 1;
/** The longest line either side reads, in characters: a screenshot comes back as base64 in one line. */
export const BRIDGE_LINE_MAX = 4 * 1024 * 1024;

const CLIENT_NAME_MAX = 64;
const CLIENT_VERSION_MAX = 32;
const ASK_MAX = 128;

export type BridgeContent = { text: string } | { image: { mime: 'image/jpeg' | 'image/png'; data: string } }; // base64

/** Lines the bridge writes to the app. `ask` is `<askId>.<secret>` from LOLPING_ASK, or null. */
export type ToBridgeApp =
  | { t: 'hello'; v: number; token: string; ask: string | null; client: { name: string; version: string } }
  | { t: 'list'; id: number }
  | { t: 'call'; id: number; name: string; args: unknown };

/** Lines the app writes to the bridge. */
export type FromBridgeApp =
  | { t: 'tools'; id: number; tools: ToolDef[] }
  | { t: 'result'; id: number; content: BridgeContent[]; isError: boolean }
  | { t: 'bye'; reason: 'token' | 'version' | 'over' };

export const encodeLine = (m: ToBridgeApp | FromBridgeApp): string => `${JSON.stringify(m)}\n`;

const TOKEN_RE = /^[0-9a-f]{64}$/;
const TOOL_NAME_RE = /^[a-z_]{1,32}$/;
const ASK_RE = /^[A-Za-z0-9-]+\.[0-9a-f]{32}$/;
const BASE64_RE = /^[A-Za-z0-9+/=]*$/;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isId = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const isShort = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;

/** One line as an object, or null for an over-long line (checked before parsing) or anything that isn't JSON. */
function parseObject(line: string): Record<string, unknown> | null {
  if (line.length > BRIDGE_LINE_MAX) return null;
  let v: unknown;
  try {
    v = JSON.parse(line);
  } catch {
    return null;
  }
  return isRecord(v) ? v : null;
}

/** One line the bridge wrote, validated from unknown; null for anything malformed. */
export function parseToApp(line: string): ToBridgeApp | null {
  const o = parseObject(line);
  if (!o) return null;
  switch (o.t) {
    case 'hello': {
      const { v, token, ask, client } = o;
      if (!Number.isSafeInteger(v) || (v as number) < 1) return null;
      if (typeof token !== 'string' || !TOKEN_RE.test(token)) return null;
      if (ask !== null && (typeof ask !== 'string' || ask.length > ASK_MAX || !ASK_RE.test(ask))) return null;
      if (!isRecord(client) || !isShort(client.name, CLIENT_NAME_MAX) || !isShort(client.version, CLIENT_VERSION_MAX)) {
        return null;
      }
      return { t: 'hello', v: v as number, token, ask, client: { name: client.name, version: client.version } };
    }
    case 'list':
      return isId(o.id) ? { t: 'list', id: o.id } : null;
    case 'call':
      // `args` is left as data (and may be missing, as for a tool without parameters): parseToolCall checks it.
      if (!isId(o.id) || typeof o.name !== 'string' || !TOOL_NAME_RE.test(o.name)) return null;
      return { t: 'call', id: o.id, name: o.name, args: o.args };
    default:
      return null;
  }
}

function parseToolDef(v: unknown): ToolDef | null {
  if (!isRecord(v) || typeof v.name !== 'string' || !TOOL_NAME_RE.test(v.name)) return null;
  if (typeof v.description !== 'string' || !isRecord(v.parameters)) return null;
  return { name: v.name, description: v.description, parameters: v.parameters };
}

function parseContent(v: unknown): BridgeContent | null {
  if (!isRecord(v)) return null;
  if ('text' in v) return typeof v.text === 'string' && !('image' in v) ? { text: v.text } : null;
  const img = v.image;
  if (!isRecord(img) || (img.mime !== 'image/jpeg' && img.mime !== 'image/png')) return null;
  if (typeof img.data !== 'string' || !BASE64_RE.test(img.data)) return null;
  return { image: { mime: img.mime, data: img.data } };
}

/** One line the app wrote, validated from unknown; null for anything malformed. */
export function parseFromApp(line: string): FromBridgeApp | null {
  const o = parseObject(line);
  if (!o) return null;
  switch (o.t) {
    case 'tools': {
      if (!isId(o.id) || !Array.isArray(o.tools)) return null;
      const tools = o.tools.map(parseToolDef);
      return tools.every((d): d is ToolDef => d !== null) ? { t: 'tools', id: o.id, tools } : null;
    }
    case 'result': {
      if (!isId(o.id) || !Array.isArray(o.content) || typeof o.isError !== 'boolean') return null;
      const content = o.content.map(parseContent);
      return content.every((c): c is BridgeContent => c !== null)
        ? { t: 'result', id: o.id, content, isError: o.isError }
        : null;
    }
    case 'bye':
      return o.reason === 'token' || o.reason === 'version' || o.reason === 'over'
        ? { t: 'bye', reason: o.reason }
        : null;
    default:
      return null;
  }
}

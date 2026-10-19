import type { ToolDef } from '../../../shared/teammate/tools';

export type Part = { text: string } | { image: { mime: 'image/jpeg'; data: Buffer } };

/** A tool call as the model sent it; arguments stay a JSON string until the controller parses them. */
export interface RawCall { id: string; name: string; args: string }

export type Turn =
  | { role: 'user'; parts: Part[] }
  | { role: 'assistant'; text: string; calls: RawCall[] }
  | { role: 'tool'; results: { id: string; content: Part[] }[] };

export interface StreamHandlers {
  /** The provider started answering: the first streamed event arrived. */
  accepted(): void;
  text(delta: string): void;
  usage(u: { input: number; output: number }): void;
}

export interface TurnResult { text: string; calls: RawCall[] }

export interface ProviderAdapter {
  turn(
    req: { system: string; turns: Turn[]; tools: ToolDef[]; model: string },
    h: StreamHandlers,
    signal: AbortSignal,
  ): Promise<TurnResult>;
  listModels(signal: AbortSignal): Promise<string[]>;
}

export type ProviderErrorKind = 'auth' | 'rate' | 'network' | 'images' | 'tools' | 'other';

export class ProviderError extends Error {
  constructor(readonly kind: ProviderErrorKind, message: string, readonly status?: number) {
    super(message);
    this.name = 'ProviderError';
  }
}

export const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Joins a base URL and a path with exactly one slash between them. */
export const joinUrl = (base: string, path: string): string => `${base.trim().replace(/\/+$/, '')}/${path}`;

// Spike 0.2 records how each provider words an image refusal; extend these when it does.
const IMAGE_REJECTION = /image|vision|multimodal|multi-modal/i;
const TOOLS_REJECTION =
  /(not support|unsupported|doesn't support).*(tool|function)|(tool|function).*(not supported|unsupported)/i;

/** The error for a refused request, from its status and the provider's message. */
export function classifyError(status: number | undefined, message: string): ProviderError {
  if (status === 401 || status === 403) return new ProviderError('auth', message, status);
  if (status === 429 || status === 529) return new ProviderError('rate', message, status);
  if (status === undefined || status === 400 || status === 422) {
    if (IMAGE_REJECTION.test(message)) return new ProviderError('images', message, status);
    if (TOOLS_REJECTION.test(message)) return new ProviderError('tools', message, status);
  }
  return new ProviderError('other', message, status);
}

/** The human message in a provider's error body: `{error: {message}}`, `{error: "…"}` or `{message}`. */
export function errorMessage(body: unknown): string | null {
  if (!isRecord(body)) return null;
  const e = body.error;
  if (typeof e === 'string') return e;
  if (isRecord(e) && typeof e.message === 'string') return e.message;
  if (typeof body.message === 'string') return body.message;
  return null;
}

/** Sends a request; a refused one becomes a classified ProviderError, an abort stays an abort. */
export async function send(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  signal: AbortSignal,
): Promise<Response> {
  let res: Response;
  try {
    res = await fetchImpl(url, { ...init, signal });
  } catch (e) {
    if (signal.aborted) throw signal.reason;
    throw new ProviderError('network', e instanceof Error ? e.message : String(e));
  }
  if (res.ok) return res;
  const raw = await res.text().catch(() => '');
  let body: unknown = null;
  try {
    body = JSON.parse(raw);
  } catch {
    // Not JSON: the raw text is the message.
  }
  const message = errorMessage(body) ?? (raw.trim().slice(0, 300) || `HTTP ${res.status}`);
  throw classifyError(res.status, message);
}

/** Reads `{data: [{id}]}`, the shape both protocols use for their model list. */
export async function readModelIds(res: Response): Promise<string[]> {
  const body: unknown = await res.json().catch(() => null);
  if (!isRecord(body) || !Array.isArray(body.data)) throw new ProviderError('other', 'Unexpected model list');
  const ids = body.data.flatMap((m: unknown) => (isRecord(m) && typeof m.id === 'string' ? [m.id] : []));
  return [...new Set(ids)].sort();
}

/** Parses an SSE data payload, or null when it isn't a JSON object. */
export function parseEvent(data: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(data);
    return isRecord(v) ? v : null;
  } catch {
    return null;
  }
}

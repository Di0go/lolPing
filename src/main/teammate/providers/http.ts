import { ProviderError } from './types';

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

// Error types and codes providers send inside a stream, by the HTTP status they stand for.
const STREAM_ERROR_STATUS: readonly [RegExp, number][] = [
  [/overload/i, 529],
  [/rate|quota|too_many/i, 429],
  [/auth|permission|api_key/i, 401],
  [/invalid_request/i, 400],
];

function streamErrorStatus(e: unknown): number | undefined {
  if (!isRecord(e)) return undefined;
  for (const v of [e.status, e.code]) {
    if (typeof v === 'number' && Number.isInteger(v)) return v;
    if (typeof v === 'string' && /^\d{3}$/.test(v)) return Number(v);
  }
  const name = [e.type, e.code].filter((v) => typeof v === 'string').join(' ');
  return STREAM_ERROR_STATUS.find(([pattern]) => pattern.test(name))?.[1];
}

/** The error for an `{error: …}` event inside a stream, classified as if the request had been refused. */
export function streamError(body: unknown): ProviderError {
  const message = errorMessage(body) ?? 'The provider reported an error';
  return classifyError(streamErrorStatus(isRecord(body) ? body.error : undefined), message);
}

/** Sends a request; a refused one becomes a classified ProviderError, an abort stays an abort. */
export async function send(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  signal: AbortSignal,
): Promise<Response> {
  // Custom profiles start without a base URL; that is a setup problem, not a network one.
  if (!/^https?:\/\/[^/]/i.test(url)) {
    throw new ProviderError('other', 'This profile has no base URL. Set one that starts with http:// or https://.');
  }
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

import type { BuiltinProfile } from '../../../shared/teammate/settings';
import { isRecord, joinUrl, parseEvent, readModelIds, send, streamError } from './http';
import { readSse } from './sse';
import { ProviderError, type Part, type ProviderAdapter, type RawCall, type Turn } from './types';

const API_VERSION = '2023-06-01';
const MAX_TOKENS = 4096;

type Block = Record<string, unknown>;
interface Message { role: 'user' | 'assistant'; content: Block[] }

const blocks = (parts: Part[]): Block[] =>
  parts.map((p) =>
    'text' in p
      ? { type: 'text', text: p.text }
      : { type: 'image', source: { type: 'base64', media_type: p.image.mime, data: p.image.data.toString('base64') } });

function toolInput(args: string): unknown {
  try {
    const v: unknown = JSON.parse(args);
    return isRecord(v) ? v : {};
  } catch {
    return {};
  }
}

// Roles must alternate, so tool results and a following user turn share one user message.
function messages(turns: Turn[]): Message[] {
  const out: Message[] = [];
  const push = (role: Message['role'], content: Block[]): void => {
    if (content.length === 0) return;
    const last = out[out.length - 1];
    if (last && last.role === role) last.content.push(...content);
    else out.push({ role, content });
  };
  for (const t of turns) {
    if (t.role === 'user') {
      push('user', blocks(t.parts));
    } else if (t.role === 'assistant') {
      push('assistant', [
        ...(t.text === '' ? [] : [{ type: 'text', text: t.text }]),
        ...t.calls.map((c) => ({ type: 'tool_use', id: c.id, name: c.name, input: toolInput(c.args) })),
      ]);
    } else {
      push('user', t.results.map((r) => ({ type: 'tool_result', tool_use_id: r.id, content: blocks(r.content) })));
    }
  }
  return out;
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** Anthropic Messages with streamed tool use. */
const finished = (c: RawCall, i: number): RawCall =>
  ({ id: c.id || `toolu_${i}`, name: c.name, args: c.args.trim() || '{}' });

export function anthropicAdapter(p: BuiltinProfile, key: string, fetchImpl: typeof fetch): ProviderAdapter {
  // The documented base has no /v1, but a pasted one may.
  const url = (path: string): string => joinUrl(p.baseUrl.trim().replace(/\/+$/, '').replace(/\/v1$/, ''), `v1/${path}`);
  const headers = (): Record<string, string> => ({
    'content-type': 'application/json',
    'x-api-key': key,
    'anthropic-version': API_VERSION,
  });
  return {
    async turn(req, h, signal) {
      const body: Record<string, unknown> = {
        model: req.model,
        max_tokens: MAX_TOKENS,
        stream: true,
        system: req.system,
        messages: messages(req.turns),
      };
      if (req.tools.length > 0) {
        body.tools = req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
      }
      const res = await send(fetchImpl, url('messages'), {
        method: 'POST', headers: headers(), body: JSON.stringify(body),
      }, signal);
      if (!res.body) throw new ProviderError('other', 'Empty response');
      // Accepted on the response itself: ping events and keepalives can precede the content.
      h.accepted();

      let text = '';
      const calls: RawCall[] = [];
      const byIndex = new Map<number, RawCall>();
      let input = 0;
      let output = 0;
      let sawUsage = false;

      await readSse(res.body, (event, data) => {
        const e = parseEvent(data);
        if (!e) return;
        const type = typeof e.type === 'string' ? e.type : event;
        if (type === 'error') throw streamError(e);
        if (type === 'message_start' && isRecord(e.message) && isRecord(e.message.usage)) {
          const u = e.message.usage;
          // Cached prompt tokens are still prompt tokens.
          input = num(u.input_tokens) + num(u.cache_creation_input_tokens) + num(u.cache_read_input_tokens);
          output = num(u.output_tokens);
          sawUsage = true;
        } else if (type === 'message_delta' && isRecord(e.usage)) {
          output = num(e.usage.output_tokens);
          sawUsage = true;
        } else if (type === 'content_block_start' && typeof e.index === 'number' && isRecord(e.content_block)) {
          const b = e.content_block;
          if (b.type === 'tool_use' && typeof b.name === 'string') {
            const call = { id: typeof b.id === 'string' ? b.id : '', name: b.name, args: '' };
            byIndex.set(e.index, call);
            calls.push(call);
          }
        } else if (type === 'content_block_delta' && typeof e.index === 'number' && isRecord(e.delta)) {
          const d = e.delta;
          if (d.type === 'text_delta' && typeof d.text === 'string' && d.text !== '') {
            text += d.text;
            h.text(d.text);
          } else if (d.type === 'input_json_delta' && typeof d.partial_json === 'string') {
            const call = byIndex.get(e.index);
            if (call) call.args += d.partial_json;
          }
        } else if (type === 'content_block_stop' && typeof e.index === 'number') {
          const call = byIndex.get(e.index);
          if (call) h.call?.(finished(call, calls.indexOf(call)));
        }
      }, signal);

      if (sawUsage) h.usage({ input, output });
      return { text, calls: calls.map(finished) };
    },

    async listModels(signal) {
      const res = await send(fetchImpl, url('models?limit=1000'), { method: 'GET', headers: headers() }, signal);
      return readModelIds(res);
    },
  };
}

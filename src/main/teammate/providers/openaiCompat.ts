import type { BuiltinProfile } from '../../../shared/teammate/settings';
import { isRecord, joinUrl, parseEvent, readModelIds, send, streamError } from './http';
import { readSse } from './sse';
import { ProviderError, type Part, type ProviderAdapter, type RawCall, type Turn } from './types';

type ContentPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };

const textOf = (parts: Part[]): string => parts.flatMap((p) => ('text' in p ? [p.text] : [])).join('\n');

const contentParts = (parts: Part[]): ContentPart[] =>
  parts.map((p) =>
    'text' in p
      ? { type: 'text', text: p.text }
      : { type: 'image_url', image_url: { url: `data:${p.image.mime};base64,${p.image.data.toString('base64')}` } });

// Text-only content goes as a plain string: some compatible servers reject the array form unless it carries images.
const content = (parts: Part[]): string | ContentPart[] =>
  parts.every((p) => 'text' in p) ? textOf(parts) : contentParts(parts);

function messages(system: string, turns: Turn[]): unknown[] {
  const out: unknown[] = [{ role: 'system', content: system }];
  for (const t of turns) {
    if (t.role === 'user') {
      out.push({ role: 'user', content: content(t.parts) });
    } else if (t.role === 'assistant') {
      out.push(t.calls.length === 0
        ? { role: 'assistant', content: t.text }
        : {
          role: 'assistant',
          content: t.text === '' ? null : t.text,
          tool_calls: t.calls.map((c) => ({
            id: c.id, type: 'function', function: { name: c.name, arguments: c.args },
          })),
        });
    } else {
      // Tool messages carry text only, so a result's images follow in a user message after the tool messages.
      const images: ContentPart[] = [];
      for (const r of t.results) {
        const pics = r.content.filter((p) => 'image' in p);
        const said = textOf(r.content) || (pics.length > 0 ? 'Image follows.' : 'Done.');
        out.push({ role: 'tool', tool_call_id: r.id, content: said });
        if (pics.length > 0) images.push(...contentParts([{ text: `Image from tool call ${r.id}:` }, ...pics]));
      }
      if (images.length > 0) out.push({ role: 'user', content: images });
    }
  }
  return out;
}

/** Chat completions with streamed tool calls, as OpenAI and the many servers that copy it speak it. */
export function openaiCompatAdapter(p: BuiltinProfile, key: string, fetchImpl: typeof fetch): ProviderAdapter {
  const headers = (): Record<string, string> => ({
    'content-type': 'application/json',
    // Local servers (Ollama, LM Studio) take no key.
    ...(key === '' ? {} : { authorization: `Bearer ${key}` }),
  });
  return {
    async turn(req, h, signal) {
      const body: Record<string, unknown> = {
        model: req.model,
        stream: true,
        messages: messages(req.system, req.turns),
      };
      // Mistral refuses fields it doesn't know and sends usage anyway.
      if (p.provider !== 'mistral') body.stream_options = { include_usage: true };
      if (req.tools.length > 0) body.tools = req.tools.map((t) => ({ type: 'function', function: t }));
      const res = await send(fetchImpl, joinUrl(p.baseUrl, 'chat/completions'), {
        method: 'POST', headers: headers(), body: JSON.stringify(body),
      }, signal);
      if (!res.body) throw new ProviderError('other', 'Empty response');
      // Accepted on the response itself: keepalive comments can precede the first event by many seconds.
      h.accepted();

      let text = '';
      // Several chunks may carry usage; the last one is the total, reported once.
      let usage = null as { input: number; output: number } | null;
      const slots: RawCall[] = [];
      const byIndex = new Map<number, RawCall>();
      const named = (): RawCall[] => slots.filter((s) => s.name !== '');
      const finished = (s: RawCall, i: number): RawCall =>
        ({ id: s.id || `call_${i}`, name: s.name, args: s.args.trim() || '{}' });
      // Calls stream one after another, so a new one starting means the ones before it are complete.
      const reported = new Set<RawCall>();
      const reportAll = (): void => {
        named().forEach((s, i) => {
          if (reported.has(s)) return;
          reported.add(s);
          h.call?.(finished(s, i));
        });
      };
      const start = (id: string): RawCall => {
        reportAll();
        const slot = { id, name: '', args: '' };
        slots.push(slot);
        return slot;
      };
      const slotFor = (tc: Record<string, unknown>): RawCall => {
        const id = typeof tc.id === 'string' ? tc.id : '';
        if (typeof tc.index === 'number') {
          const known = byIndex.get(tc.index);
          if (known) return known;
          const slot = start(id);
          byIndex.set(tc.index, slot);
          return slot;
        }
        // Without an index, a new id starts a call and anything else continues the last one.
        const known = id === '' ? slots[slots.length - 1] : slots.find((s) => s.id === id);
        return known ?? start(id);
      };

      const readUsage = (u: unknown): void => {
        if (isRecord(u) && typeof u.prompt_tokens === 'number' && typeof u.completion_tokens === 'number') {
          usage = { input: u.prompt_tokens, output: u.completion_tokens };
        }
      };

      await readSse(res.body, (_event, data) => {
        if (data === '[DONE]') return;
        const chunk = parseEvent(data);
        if (!chunk) return;
        if (chunk.error !== undefined && chunk.error !== null) throw streamError(chunk);
        readUsage(chunk.usage);
        const choice: unknown = Array.isArray(chunk.choices) ? chunk.choices[0] : undefined;
        // Kimi (Moonshot) puts usage on the choice instead of the chunk.
        if (isRecord(choice)) readUsage(choice.usage);
        const delta = isRecord(choice) ? choice.delta : undefined;
        if (!isRecord(delta)) return;
        if (typeof delta.content === 'string' && delta.content !== '') {
          text += delta.content;
          h.text(delta.content);
        }
        if (!Array.isArray(delta.tool_calls)) return;
        for (const tc of delta.tool_calls) {
          if (!isRecord(tc)) continue;
          const slot = slotFor(tc);
          if (slot.id === '' && typeof tc.id === 'string') slot.id = tc.id;
          const f = tc.function;
          if (!isRecord(f)) continue;
          // Some servers repeat the name on every chunk, so it is set, never appended.
          if (typeof f.name === 'string' && f.name !== '') slot.name = f.name;
          if (typeof f.arguments === 'string') slot.args += f.arguments;
        }
      }, signal);

      reportAll();
      if (usage) h.usage(usage);
      return { text, calls: named().map(finished) };
    },

    async listModels(signal) {
      const res = await send(fetchImpl, joinUrl(p.baseUrl, 'models'), { method: 'GET', headers: headers() }, signal);
      return readModelIds(res);
    },
  };
}

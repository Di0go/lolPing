import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAdapter } from '../../../src/main/teammate/providers';
import { readSse } from '../../../src/main/teammate/providers/sse';
import { ProviderError, type RawCall, type StreamHandlers, type Turn } from '../../../src/main/teammate/providers/types';
import type { BuiltinProfile } from '../../../src/shared/teammate/settings';
import { parseToolCall, type ToolDef } from '../../../src/shared/teammate/tools';
import { startFakeProvider } from '../fixtures/fakeProvider';

type Fake = Awaited<ReturnType<typeof startFakeProvider>>;
let fake: Fake;
beforeEach(async () => { fake = await startFakeProvider(); });
afterEach(async () => { await fake.close(); });

const profile = (protocol: 'openai' | 'anthropic', baseUrl: string): BuiltinProfile => ({
  id: 'p1', kind: 'builtin', name: 'Test', tagColor: 0, tagColorCustom: null,
  provider: protocol === 'openai' ? 'custom' : 'anthropic', protocol, baseUrl, model: 'test-model',
});

const TOOLS: ToolDef[] = [
  { name: 'say', description: 'Say a line.', parameters: { type: 'object', properties: { text: { type: 'string' } } } },
];
const ASK: Turn[] = [{ role: 'user', parts: [{ text: 'hello' }] }];

type Recorder = StreamHandlers & {
  texts: string[]; usages: { input: number; output: number }[]; calls: RawCall[]; log: string[];
};

function recorder(onText?: () => void): Recorder & { accepted: ReturnType<typeof vi.fn<() => void>> } {
  const texts: string[] = [];
  const usages: { input: number; output: number }[] = [];
  const calls: RawCall[] = [];
  const log: string[] = [];
  return {
    accepted: vi.fn<() => void>(() => { log.push('accepted'); }),
    text: (d) => { texts.push(d); log.push('text'); onText?.(); },
    usage: (u) => { usages.push(u); },
    call: (c) => { calls.push(c); log.push('call'); },
    texts,
    usages,
    calls,
    log,
  };
}

const data = (v: unknown): string => `data: ${JSON.stringify(v)}\n\n`;
const ev = (type: string, v: Record<string, unknown>): string =>
  `event: ${type}\ndata: ${JSON.stringify({ type, ...v })}\n\n`;
const delta = (d: Record<string, unknown>): string => data({ choices: [{ index: 0, delta: d }] });
const tc = (index: number, f: Record<string, unknown>, id?: string): string =>
  delta({ tool_calls: [{ index, ...(id ? { id, type: 'function' } : {}), function: f }] });

const OPENAI_STREAM = (() => {
  const split = tc(1, { arguments: '"x":1,"y":2}' });
  return [
    data({
      choices: [{ index: 0, delta: { role: 'assistant', content: 'On ' }, usage: { prompt_tokens: 3, completion_tokens: 1 } }],
    }),
    delta({ content: 'it.' }),
    tc(0, { name: 'say', arguments: '' }, 'call_1'),
    tc(0, { arguments: '{"text":' }),
    tc(0, { arguments: '"hi"}' }),
    tc(1, { name: 'ping', arguments: '{"type":"danger",' }, 'call_2'),
    split.slice(0, 30),
    split.slice(30),
    data({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } }),
    'data: [DONE]\n\n',
  ];
})();

const ANTHROPIC_STREAM = (() => {
  const split = ev('content_block_delta', {
    index: 2, delta: { type: 'input_json_delta', partial_json: '"x":1,"y":2}' },
  });
  return [
    ev('message_start', { message: { id: 'm1', usage: { input_tokens: 12, output_tokens: 1 } } }),
    ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
    ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'On ' } }),
    ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'it.' } }),
    ev('content_block_stop', { index: 0 }),
    ev('content_block_start', { index: 1, content_block: { type: 'tool_use', id: 'toolu_1', name: 'say', input: {} } }),
    ev('content_block_delta', { index: 1, delta: { type: 'input_json_delta', partial_json: '{"text":' } }),
    ev('content_block_delta', { index: 1, delta: { type: 'input_json_delta', partial_json: '"hi"}' } }),
    ev('content_block_stop', { index: 1 }),
    ev('ping', {}),
    ev('content_block_start', { index: 2, content_block: { type: 'tool_use', id: 'toolu_2', name: 'ping', input: {} } }),
    ev('content_block_delta', { index: 2, delta: { type: 'input_json_delta', partial_json: '{"type":"danger",' } }),
    split.slice(0, 25),
    split.slice(25),
    ev('content_block_stop', { index: 2 }),
    ev('message_delta', { delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 30 } }),
    ev('message_stop', {}),
  ];
})();

function lastBody(): Record<string, unknown> {
  return JSON.parse(fake.requests[fake.requests.length - 1].body) as Record<string, unknown>;
}

describe('readSse', () => {
  it('joins events split across chunks and lines ending in CRLF', async () => {
    const parts = ['event: a\r', '\ndata: 1\r\ndata: ', '2\r\n\r\n: comment\n', 'data: 3\n', '\n', 'data: tail'];
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        for (const p of parts) c.enqueue(new TextEncoder().encode(p));
        c.close();
      },
    });
    const got: [string, string][] = [];
    await readSse(body, (e, d) => { got.push([e, d]); });
    expect(got).toEqual([['a', '1\n2'], ['message', '3'], ['message', 'tail']]);
  });

  it('keeps a multi-byte character that is split across chunks', async () => {
    const bytes = new TextEncoder().encode('data: 中文\n\n');
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(bytes.slice(0, 7));
        c.enqueue(bytes.slice(7));
        c.close();
      },
    });
    const got: string[] = [];
    await readSse(body, (_e, d) => { got.push(d); });
    expect(got).toEqual(['中文']);
  });

  it('dispatches nothing after an abort, even later events in the same chunk', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(new TextEncoder().encode('data: 1\n\ndata: 2\n\ndata: 3\n\n')); },
    });
    const ctrl = new AbortController();
    const got: string[] = [];
    const e: unknown = await readSse(body, (_e, d) => { got.push(d); ctrl.abort(); }, ctrl.signal)
      .then(() => null, (err: unknown) => err);
    expect(e).toMatchObject({ name: 'AbortError' });
    expect(got).toEqual(['1']);
  });
});

describe('provider adapters', () => {
  it('streams text and tool calls from an OpenAI-compatible server', async () => {
    fake.reply({ sse: OPENAI_STREAM });
    const h = recorder();
    const out = await createAdapter(profile('openai', `${fake.url}/v1/`), 'sk-test')
      .turn({ system: 'Be brief.', turns: ASK, tools: TOOLS, model: 'm1' }, h, new AbortController().signal);
    expect(out).toEqual({
      text: 'On it.',
      calls: [
        { id: 'call_1', name: 'say', args: '{"text":"hi"}' },
        { id: 'call_2', name: 'ping', args: '{"type":"danger","x":1,"y":2}' },
      ],
    });
    expect(parseToolCall(out.calls[1].name, out.calls[1].args)).toEqual({
      tool: 'ping', type: 'danger', at: { x: 1, y: 2 },
    });
    expect(h.accepted).toHaveBeenCalledTimes(1);
    expect(h.texts).toEqual(['On ', 'it.']);
    expect(h.usages).toEqual([{ input: 10, output: 5 }]);
    expect(h.log[0]).toBe('accepted');
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]).toMatchObject({ method: 'POST', url: '/v1/chat/completions' });
    expect(lastBody()).toMatchObject({
      model: 'm1',
      stream: true,
      messages: [{ role: 'system', content: 'Be brief.' }, { role: 'user', content: 'hello' }],
      tools: [{ type: 'function', function: TOOLS[0] }],
    });
  });

  it('streams text and tool calls from an Anthropic server', async () => {
    fake.reply({ sse: ANTHROPIC_STREAM });
    const h = recorder();
    const out = await createAdapter(profile('anthropic', fake.url), 'sk-ant')
      .turn({ system: 'Be brief.', turns: ASK, tools: TOOLS, model: 'm1' }, h, new AbortController().signal);
    expect(out).toEqual({
      text: 'On it.',
      calls: [
        { id: 'toolu_1', name: 'say', args: '{"text":"hi"}' },
        { id: 'toolu_2', name: 'ping', args: '{"type":"danger","x":1,"y":2}' },
      ],
    });
    expect(h.accepted).toHaveBeenCalledTimes(1);
    expect(h.texts).toEqual(['On ', 'it.']);
    expect(h.usages).toEqual([{ input: 12, output: 30 }]);
    expect(h.log[0]).toBe('accepted');
    expect(fake.requests[0]).toMatchObject({ method: 'POST', url: '/v1/messages' });
    expect(lastBody()).toMatchObject({
      model: 'm1',
      stream: true,
      system: 'Be brief.',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
      tools: [{ name: 'say', description: 'Say a line.', input_schema: TOOLS[0].parameters }],
    });
  });

  it('reports each tool call as it completes, the same as the turn returns it', async () => {
    for (const [protocol, sse, base] of [
      ['openai', OPENAI_STREAM, `${fake.url}/v1`], ['anthropic', ANTHROPIC_STREAM, fake.url],
    ] as const) {
      fake.reply({ sse });
      const h = recorder();
      const out = await createAdapter(profile(protocol, base), 'k')
        .turn({ system: '', turns: ASK, tools: TOOLS, model: 'm' }, h, new AbortController().signal);
      expect(h.calls, protocol).toEqual(out.calls);
    }
  });

  it('reports a finished say while the rest of the answer is still streaming', async () => {
    const openaiHead = OPENAI_STREAM.slice(0, OPENAI_STREAM.findIndex((c) => c.includes('"ping"')) + 1);
    const anthropicHead = ANTHROPIC_STREAM.slice(0, ANTHROPIC_STREAM.findIndex((c) => c.includes('"ping"')));
    for (const [protocol, sse, base] of [
      ['openai', openaiHead, `${fake.url}/v1`], ['anthropic', anthropicHead, fake.url],
    ] as const) {
      fake.reply({ sse, hold: true });
      const h = recorder();
      const abort = new AbortController();
      const turn = createAdapter(profile(protocol, base), 'k')
        .turn({ system: '', turns: ASK, tools: TOOLS, model: 'm' }, h, abort.signal)
        .catch(() => null);
      await vi.waitFor(() => expect(h.calls, protocol).toHaveLength(1));
      expect(h.calls[0]).toMatchObject({ name: 'say', args: '{"text":"hi"}' });
      abort.abort();
      await turn;
    }
  });

  it('sends the image as a JPEG data part and the key in the right header', async () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff]);
    const turns: Turn[] = [
      { role: 'user', parts: [{ text: 'what is this' }, { image: { mime: 'image/jpeg', data: jpeg } }] },
      { role: 'assistant', text: '', calls: [{ id: 'c1', name: 'look', args: '{"x":0,"y":0,"w":10,"h":10}' }] },
      {
        role: 'tool',
        results: [{ id: 'c1', content: [{ text: 'zoomed' }, { image: { mime: 'image/jpeg', data: jpeg } }] }],
      },
    ];
    const url = `data:image/jpeg;base64,${jpeg.toString('base64')}`;

    fake.reply({ sse: ['data: [DONE]\n\n'] });
    await createAdapter(profile('openai', fake.url), 'sk-test')
      .turn({ system: 's', turns, tools: TOOLS, model: 'm' }, recorder(), new AbortController().signal);
    expect(fake.requests[0].headers.authorization).toBe('Bearer sk-test');
    expect(fake.requests[0].headers['x-api-key']).toBeUndefined();
    expect(lastBody().messages).toEqual([
      { role: 'system', content: 's' },
      { role: 'user', content: [{ type: 'text', text: 'what is this' }, { type: 'image_url', image_url: { url } }] },
      { role: 'assistant', content: null, tool_calls: [
        { id: 'c1', type: 'function', function: { name: 'look', arguments: '{"x":0,"y":0,"w":10,"h":10}' } },
      ] },
      { role: 'tool', tool_call_id: 'c1', content: 'zoomed' },
      {
        role: 'user',
        content: [{ type: 'text', text: 'Image from tool call c1:' }, { type: 'image_url', image_url: { url } }],
      },
    ]);

    fake.reply({ sse: [ev('message_stop', {})] });
    await createAdapter(profile('anthropic', fake.url), 'sk-ant')
      .turn({ system: 's', turns, tools: TOOLS, model: 'm' }, recorder(), new AbortController().signal);
    expect(fake.requests[1].headers['x-api-key']).toBe('sk-ant');
    expect(fake.requests[1].headers['anthropic-version']).toBe('2023-06-01');
    expect(fake.requests[1].headers.authorization).toBeUndefined();
    const image = { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: jpeg.toString('base64') } };
    expect(lastBody().messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'what is this' }, image] },
      { role: 'assistant', content: [
        { type: 'tool_use', id: 'c1', name: 'look', input: { x: 0, y: 0, w: 10, h: 10 } },
      ] },
      { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'c1', content: [{ type: 'text', text: 'zoomed' }, image] },
      ] },
    ]);
  });

  for (const protocol of ['openai', 'anthropic'] as const) {
    const turn = (): Promise<unknown> => createAdapter(profile(protocol, fake.url), 'k')
      .turn({ system: 's', turns: ASK, tools: TOOLS, model: 'm' }, recorder(), new AbortController().signal);
    const failure = async (): Promise<ProviderError> => {
      const e: unknown = await turn().then(() => null, (err: unknown) => err);
      expect(e).toBeInstanceOf(ProviderError);
      return e as ProviderError;
    };

    it(`maps 401 to auth and 429 to rate (${protocol})`, async () => {
      fake.reply({ status: 401, json: { error: { message: 'Incorrect API key provided' } } });
      expect(await failure()).toMatchObject({ kind: 'auth', status: 401, message: 'Incorrect API key provided' });
      fake.reply({ status: 429, json: { error: { type: 'rate_limit_error', message: 'Slow down' } } });
      expect(await failure()).toMatchObject({ kind: 'rate', status: 429 });
      fake.reply({ status: 500, json: { error: 'boom' } });
      expect(await failure()).toMatchObject({ kind: 'other', status: 500, message: 'boom' });
    });

    it(`maps an image rejection to images (${protocol})`, async () => {
      fake.reply({ status: 400, json: { error: { message: 'This model does not support Image input.' } } });
      expect(await failure()).toMatchObject({ kind: 'images', status: 400 });
      fake.reply({ status: 422, json: { message: 'Multimodal content is not supported' } });
      expect(await failure()).toMatchObject({ kind: 'images', status: 422 });
      const ollama = 'registry.ollama.ai/library/gemma:2b does not support tools';
      fake.reply({ status: 400, json: { error: { message: ollama } } });
      expect(await failure()).toMatchObject({ kind: 'tools', status: 400 });
      fake.reply({ status: 400, json: { error: { message: 'max_tokens is too large' } } });
      expect(await failure()).toMatchObject({ kind: 'other', status: 400 });
    });

    it(`lists models without asking for a completion (${protocol})`, async () => {
      fake.reply({ status: 200, json: { data: [{ id: 'model-b' }, { id: 'model-a' }, { name: 'no id' }, 'junk'] } });
      const models = await createAdapter(profile(protocol, fake.url), 'k').listModels(new AbortController().signal);
      expect(models).toEqual(['model-a', 'model-b']);
      expect(fake.requests.map((r) => r.method)).toEqual(['GET']);
      expect(fake.requests[0].url).toBe(protocol === 'openai' ? '/models' : '/v1/models?limit=1000');
    });

    it(`counts a stream as accepted before its first event (${protocol})`, async () => {
      fake.reply({ sse: [': OPENROUTER PROCESSING\n\n', ': OPENROUTER PROCESSING\n\n'], hold: true });
      const ctrl = new AbortController();
      const h = recorder();
      const done = createAdapter(profile(protocol, fake.url), 'k')
        .turn({ system: 's', turns: ASK, tools: TOOLS, model: 'm' }, h, ctrl.signal)
        .then(() => null, (err: unknown) => err);
      await vi.waitFor(() => expect(h.accepted).toHaveBeenCalledTimes(1));
      ctrl.abort();
      expect(await done).toMatchObject({ name: 'AbortError' });
      expect(h.texts).toEqual([]);
    });

    it(`maps errors sent inside the stream like refused requests (${protocol})`, async () => {
      const streamError = (type: string, message: string): string => protocol === 'openai'
        ? data({ error: { type, message } })
        : ev('error', { error: { type, message } });
      const cases: [string, string, string][] = [
        ['overloaded_error', 'Overloaded', 'rate'],
        ['rate_limit_error', 'Too many requests', 'rate'],
        ['authentication_error', 'invalid x-api-key', 'auth'],
        ['invalid_request_error', 'Image input is not supported by this model', 'images'],
        ['api_error', 'Internal error', 'other'],
      ];
      for (const [type, message, kind] of cases) {
        fake.reply({ sse: [streamError(type, message)] });
        expect(await failure(), type).toMatchObject({ kind, message });
      }
      if (protocol === 'openai') {
        fake.reply({ sse: [data({ error: { code: 429, message: 'Rate limit reached' } })] });
        expect(await failure()).toMatchObject({ kind: 'rate' });
      }
    });

    it(`stops when aborted (${protocol})`, async () => {
      const first = protocol === 'openai'
        ? delta({ content: 'Hel' })
        : ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'Hel' } });
      fake.reply({ sse: [first], hold: true });
      const ctrl = new AbortController();
      const h = recorder(() => ctrl.abort());
      const e: unknown = await createAdapter(profile(protocol, fake.url), 'k')
        .turn({ system: 's', turns: ASK, tools: TOOLS, model: 'm' }, h, ctrl.signal)
        .then(() => null, (err: unknown) => err);
      expect(e).toMatchObject({ name: 'AbortError' });
      expect(h.texts).toEqual(['Hel']);
      await vi.waitFor(() => expect(fake.dropped()).toBe(1));
    });
  }

  it('reports a profile without a base URL as other, without a request', async () => {
    const e: unknown = await createAdapter(profile('openai', ''), 'k')
      .turn({ system: 's', turns: ASK, tools: [], model: 'm' }, recorder(), new AbortController().signal)
      .then(() => null, (err: unknown) => err);
    expect(e).toBeInstanceOf(ProviderError);
    expect(e).toMatchObject({ kind: 'other', message: expect.stringMatching(/base URL/) });
    expect(fake.requests).toEqual([]);
  });

  it('reports usage once, from the last chunk that carried it', async () => {
    fake.reply({ sse: [
      data({ choices: [{ index: 0, delta: { content: 'a' }, usage: { prompt_tokens: 7, completion_tokens: 2 } }] }),
      data({
        choices: [{ index: 0, delta: {}, finish_reason: 'stop', usage: { prompt_tokens: 7, completion_tokens: 4 } }],
      }),
      'data: [DONE]\n\n',
    ] });
    const h = recorder();
    await createAdapter(profile('openai', fake.url), 'k')
      .turn({ system: 's', turns: ASK, tools: [], model: 'm' }, h, new AbortController().signal);
    expect(h.usages).toEqual([{ input: 7, output: 4 }]);
  });

  it('reports a server it cannot reach as network', async () => {
    const url = fake.url;
    await fake.close();
    fake = await startFakeProvider();
    const e: unknown = await createAdapter(profile('openai', url), 'k')
      .turn({ system: 's', turns: ASK, tools: [], model: 'm' }, recorder(), new AbortController().signal)
      .then(() => null, (err: unknown) => err);
    expect(e).toBeInstanceOf(ProviderError);
    expect(e).toMatchObject({ kind: 'network' });
  });
});

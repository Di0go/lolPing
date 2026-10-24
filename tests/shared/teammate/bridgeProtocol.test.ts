import { describe, expect, it } from 'vitest';
import {
  BRIDGE_LINE_MAX, BRIDGE_VERSION, encodeLine, parseFromApp, parseToApp,
  type FromBridgeApp, type ToBridgeApp,
} from '../../../src/shared/teammate/bridgeProtocol';

const TOKEN = 'ab12'.repeat(16);
const ASK = `ask-7.${'0f'.repeat(16)}`;
const hello = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  t: 'hello', v: BRIDGE_VERSION, token: TOKEN, ask: null, client: { name: 'claude-code', version: '1.2.3' }, ...over,
});
const result = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  t: 'result', id: 3, content: [{ text: 'ok' }], isError: false, ...over,
});

describe('bridgeProtocol', () => {
  it('round-trips every message', () => {
    const toApp: ToBridgeApp[] = [
      { t: 'hello', v: BRIDGE_VERSION, token: TOKEN, ask: null, client: { name: 'a', version: '1' } },
      { t: 'hello', v: 2, token: TOKEN, ask: ASK, client: { name: 'claude-code', version: '1.2.3' } },
      { t: 'list', id: 0 },
      { t: 'call', id: 7, name: 'look_at_screen', args: { zoom: [1, 2], note: null } },
      { t: 'call', id: 8, name: 'say', args: 'plain string' },
    ];
    for (const m of toApp) {
      const line = encodeLine(m);
      expect(line.endsWith('\n')).toBe(true);
      expect(line.slice(0, -1)).not.toContain('\n');
      expect(parseToApp(line.slice(0, -1))).toEqual(m);
    }
    const fromApp: FromBridgeApp[] = [
      { t: 'tools', id: 1, tools: [{ name: 'say', description: 'Say a line.', parameters: { type: 'object' } }] },
      { t: 'tools', id: 2, tools: [] },
      {
        t: 'result', id: 3, isError: false,
        content: [
          { text: 'hi' }, { image: { mime: 'image/jpeg', data: 'QUJD/+9=' } },
          { image: { mime: 'image/png', data: '' } },
        ],
      },
      { t: 'result', id: 4, content: [], isError: true },
      { t: 'bye', reason: 'token' },
      { t: 'bye', reason: 'version' },
      { t: 'bye', reason: 'over' },
    ];
    for (const m of fromApp) {
      const line = encodeLine(m);
      expect(line.endsWith('\n')).toBe(true);
      expect(parseFromApp(line.slice(0, -1))).toEqual(m);
    }
  });

  it('rejects lines over the limit, bad ids, bad names and bad tokens', () => {
    const big = JSON.stringify({ t: 'call', id: 1, name: 'say', args: 'x'.repeat(BRIDGE_LINE_MAX) });
    expect(big.length).toBeGreaterThan(BRIDGE_LINE_MAX);
    expect(parseToApp(big)).toBeNull();
    expect(parseFromApp(JSON.stringify(result({ content: [{ text: 'x'.repeat(BRIDGE_LINE_MAX) }] })))).toBeNull();
    const atLimit = JSON.stringify({ t: 'call', id: 1, name: 'say', args: '' });
    const fill = 'x'.repeat(BRIDGE_LINE_MAX - atLimit.length);
    const padded = JSON.stringify({ t: 'call', id: 1, name: 'say', args: fill });
    expect(padded.length).toBe(BRIDGE_LINE_MAX);
    expect(parseToApp(padded)).not.toBeNull();

    expect(parseToApp('not json')).toBeNull();
    expect(parseToApp('')).toBeNull();
    expect(parseToApp('[]')).toBeNull();
    expect(parseToApp('null')).toBeNull();
    expect(parseToApp(JSON.stringify({ t: 'nope' }))).toBeNull();
    expect(parseFromApp('{')).toBeNull();
    expect(parseFromApp(JSON.stringify({ t: 'hello' }))).toBeNull();

    for (const id of [-1, 1.5, '1', null, Number.NaN, Number.MAX_SAFE_INTEGER + 2]) {
      expect(parseToApp(JSON.stringify({ t: 'list', id }))).toBeNull();
      expect(parseToApp(JSON.stringify({ t: 'call', id, name: 'say', args: {} }))).toBeNull();
      expect(parseFromApp(JSON.stringify(result({ id })))).toBeNull();
      expect(parseFromApp(JSON.stringify({ t: 'tools', id, tools: [] }))).toBeNull();
    }
    expect(parseToApp('{"t":"list"}')).toBeNull();

    for (const name of ['', 'Say', 'say2', 'say-it', 'a'.repeat(33), 5, null]) {
      expect(parseToApp(JSON.stringify({ t: 'call', id: 1, name, args: {} }))).toBeNull();
    }
    expect(parseToApp(JSON.stringify({ t: 'call', id: 1, name: 'a'.repeat(32), args: {} }))).not.toBeNull();

    for (const token of ['', 'ab12', TOKEN.toUpperCase(), `${TOKEN}0`, 'g'.repeat(64), 7, null]) {
      expect(parseToApp(JSON.stringify(hello({ token })))).toBeNull();
    }
    for (const v of [0, -1, 1.5, '1', null]) expect(parseToApp(JSON.stringify(hello({ v })))).toBeNull();
    expect(parseToApp(JSON.stringify(hello({ v: 9 })))).not.toBeNull();

    for (const client of [null, [], {}, { name: 'a' }, { name: 'a', version: 1 }, { name: '', version: '1' },
      { name: 'a'.repeat(65), version: '1' }, { name: 'a', version: 'v'.repeat(33) }]) {
      expect(parseToApp(JSON.stringify(hello({ client })))).toBeNull();
    }
    const longest = { name: 'a'.repeat(64), version: 'v'.repeat(32) };
    expect(parseToApp(JSON.stringify(hello({ client: longest })))).not.toBeNull();

    const badAsk = ['', 'noDot', `ask.${'0f'.repeat(15)}`, `ask.${'0F'.repeat(16)}`, `.${'0f'.repeat(16)}`, 5,
      `${'a'.repeat(100)}.${'0f'.repeat(16)}`, `ask 1.${'0f'.repeat(16)}`];
    for (const ask of badAsk) expect(parseToApp(JSON.stringify(hello({ ask })))).toBeNull();
    expect(parseToApp(JSON.stringify(hello({ ask: undefined })))).toBeNull();
    expect(parseToApp(JSON.stringify(hello({ ask: ASK })))).not.toBeNull();

    expect(parseFromApp(JSON.stringify({ t: 'bye', reason: 'later' }))).toBeNull();
    expect(parseFromApp(JSON.stringify({ t: 'bye' }))).toBeNull();
    expect(parseFromApp(JSON.stringify(result({ isError: 'no' })))).toBeNull();
    expect(parseFromApp(JSON.stringify(result({ content: 'text' })))).toBeNull();
  });

  it('rejects a tools list or result content that is not well formed', () => {
    const def = { name: 'say', description: 'd', parameters: {} };
    const tools = (list: unknown): string => JSON.stringify({ t: 'tools', id: 1, tools: list });
    expect(parseFromApp(tools([def]))).not.toBeNull();
    expect(parseFromApp(tools('x'))).toBeNull();
    for (const bad of [
      { ...def, name: 'Say' }, { ...def, name: '' }, { ...def, description: 3 }, { ...def, parameters: [] },
      { ...def, parameters: null }, { ...def, parameters: 'x' }, { name: 'say', description: 'd' }, null, 'say',
    ]) {
      expect(parseFromApp(tools([def, bad]))).toBeNull();
    }

    const content = (items: unknown): string => JSON.stringify(result({ content: items }));
    const png = { image: { mime: 'image/png', data: 'AAAA' } };
    expect(parseFromApp(content([{ text: '' }, png]))).not.toBeNull();
    for (const bad of [
      { text: 4 }, {}, { text: 'a', image: png.image }, { image: { mime: 'image/gif', data: 'AAAA' } },
      { image: { mime: 'image/png', data: 'AA AA' } }, { image: { mime: 'image/png', data: 'AA-_' } },
      { image: { mime: 'image/png', data: 5 } }, { image: { mime: 'image/png' } }, { image: 'AAAA' }, null, 'text',
    ]) {
      expect(parseFromApp(content([{ text: 'fine' }, bad]))).toBeNull();
    }
  });

  it('keeps call arguments as data for the tool parser', () => {
    const args = { text: 'hi', spots: [{ x: 1, y: 2 }], nested: { deep: [null, true, 'x'] } };
    expect(parseToApp(JSON.stringify({ t: 'call', id: 5, name: 'say', args }))).toEqual(
      { t: 'call', id: 5, name: 'say', args },
    );
    expect(parseToApp(JSON.stringify({ t: 'call', id: 1, name: 'say' }))).toEqual(
      { t: 'call', id: 1, name: 'say', args: undefined },
    );
    for (const odd of [null, 3, 'x', [1, 2], {}]) {
      expect(parseToApp(JSON.stringify({ t: 'call', id: 1, name: 'say', args: odd }))).toEqual(
        { t: 'call', id: 1, name: 'say', args: odd },
      );
    }
  });

  it('drops unknown fields so only the wire format passes through', () => {
    expect(parseToApp(JSON.stringify({ t: 'list', id: 4, extra: 'x' }))).toStrictEqual({ t: 'list', id: 4 });
    expect(parseFromApp(JSON.stringify({ t: 'bye', reason: 'over', extra: 1 }))).toStrictEqual(
      { t: 'bye', reason: 'over' },
    );
  });
});

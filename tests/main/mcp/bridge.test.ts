import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { ReadBuffer, serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { Duplex, PassThrough, type Readable, type Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { runBridge } from '../../../src/main/mcp/bridge';
import {
  BRIDGE_VERSION, encodeLine, parseToApp, type BridgeContent, type FromBridgeApp, type ToBridgeApp,
} from '../../../src/shared/teammate/bridgeProtocol';
import type { ToolDef } from '../../../src/shared/teammate/tools';
import pkg from '../../../package.json';

const TOKEN = 'ab'.repeat(32);
const ASK = `ask-7.${'0f'.repeat(16)}`;
const LOOK: ToolDef = { name: 'look', description: 'Look at the screen.', parameters: { type: 'object', properties: {} } };

/** The MCP client's end of the stdio streams: the SDK's Client talks through this. */
class StreamTransport implements Transport {
  onmessage?: (m: JSONRPCMessage) => void;
  onclose?: () => void;
  onerror?: (e: Error) => void;
  private readonly buffer = new ReadBuffer();
  constructor(private readonly input: Readable, private readonly output: Writable) {}
  async start(): Promise<void> {
    this.input.on('data', (chunk: Buffer) => {
      this.buffer.append(chunk);
      for (let m = this.buffer.readMessage(); m; m = this.buffer.readMessage()) this.onmessage?.(m);
    });
  }
  async send(m: JSONRPCMessage): Promise<void> {
    this.output.write(serializeMessage(m));
  }
  async close(): Promise<void> {
    this.output.end();
    this.onclose?.();
  }
}

/** The app's end of the pipe: records what the bridge wrote and answers with `reply`. */
class FakeApp {
  readonly received: ToBridgeApp[] = [];
  readonly duplex: Duplex;
  private partial = '';
  constructor(private readonly reply: (m: ToBridgeApp, send: (r: FromBridgeApp) => void) => void) {
    this.duplex = new Duplex({
      read: () => undefined,
      write: (chunk: Buffer, _enc, done) => {
        this.partial += chunk.toString('utf8');
        const lines = this.partial.split('\n');
        this.partial = lines.pop() ?? '';
        for (const line of lines) {
          const m = parseToApp(line);
          if (!m) continue;
          this.received.push(m);
          this.reply(m, (r) => this.duplex.push(encodeLine(r)));
        }
        done();
      },
    });
  }
}

interface Rig { client: Client; done: Promise<void>; connects: () => number }

function rig(opts: {
  app?: FakeApp;
  env?: NodeJS.ProcessEnv;
  token?: () => Promise<string>;
  clientInfo?: { name: string; version: string };
} = {}): Promise<Rig> {
  const toBridge = new PassThrough();
  const fromBridge = new PassThrough();
  let connects = 0;
  const done = runBridge({
    stdin: toBridge,
    stdout: fromBridge,
    env: opts.env ?? {},
    readToken: opts.token ?? (async () => `${TOKEN}\n`),
    connect: () => {
      connects += 1;
      if (opts.app) return opts.app.duplex;
      // No app: a socket that fails, like a pipe nobody listens on.
      const dead = new Duplex({ read: () => undefined, write: (_c, _e, cb) => cb() });
      queueMicrotask(() => dead.destroy(new Error('ENOENT')));
      return dead;
    },
  });
  const client = new Client(opts.clientInfo ?? { name: 'test-agent', version: '1.2.3' });
  return client.connect(new StreamTransport(fromBridge, toBridge)).then(() => ({ client, done, connects: () => connects }));
}

const textOf = (r: unknown): string => {
  const first = (r as { content: { type: string; text?: string }[] }).content[0];
  return first?.text ?? '';
};

describe('runBridge', () => {
  it('relays tools/list and tools/call to the app', async () => {
    const app = new FakeApp((m, send) => {
      if (m.t === 'list') send({ t: 'tools', id: m.id, tools: [LOOK] });
      if (m.t === 'call') send({ t: 'result', id: m.id, content: [{ text: `ran ${m.name}` }], isError: false });
    });
    const { client } = await rig({ app, env: { LOLPING_ASK: ASK } });
    const listed = await client.listTools();
    expect(listed.tools).toEqual([{ name: 'look', description: 'Look at the screen.', inputSchema: LOOK.parameters }]);
    const called = await client.callTool({ name: 'look', arguments: { a: 1 } });
    expect(called.isError).toBe(false);
    expect(textOf(called)).toBe('ran look');
    expect(app.received).toEqual([
      { t: 'hello', v: BRIDGE_VERSION, token: TOKEN, ask: ASK, client: { name: 'test-agent', version: '1.2.3' } },
      { t: 'list', id: 0 },
      { t: 'call', id: 1, name: 'look', args: { a: 1 } },
    ]);
    await client.close();
  });

  it('says hello with no ask, and cuts a long client name and version to the protocol limits', async () => {
    const app = new FakeApp((m, send) => {
      if (m.t === 'list') send({ t: 'tools', id: m.id, tools: [] });
    });
    const { client } = await rig({ app, clientInfo: { name: 'n'.repeat(100), version: 'v'.repeat(50) } });
    await client.listTools();
    expect(app.received[0]).toMatchObject({
      t: 'hello', ask: null, client: { name: 'n'.repeat(64), version: 'v'.repeat(32) },
    });
    await client.close();
  });

  it("says lolPing isn't running when the pipe is missing", async () => {
    const { client, connects } = await rig();
    const listed = await client.listTools();
    expect(listed.tools.map((t) => t.name)).toEqual(['say', 'ping', 'emote', 'answer']);
    const called = await client.callTool({ name: 'say', arguments: { text: 'hi' } });
    expect(called.isError).toBe(true);
    expect(textOf(called)).toBe("lolPing isn't running");
    expect(connects()).toBe(2); // each request tries the pipe again
    await client.close();
  });

  it("says lolPing isn't running when the token file cannot be read", async () => {
    const app = new FakeApp(() => undefined);
    const { client } = await rig({ app, token: () => Promise.reject(new Error('ENOENT')) });
    const called = await client.callTool({ name: 'say', arguments: {} });
    expect(called.isError).toBe(true);
    expect(textOf(called)).toBe("lolPing isn't running");
    expect(app.received).toEqual([]);
    await client.close();
  });

  it('says the ask is over after a bye over', async () => {
    const app = new FakeApp((m, send) => {
      if (m.t === 'call') send({ t: 'bye', reason: 'over' });
    });
    const { client } = await rig({ app });
    const called = await client.callTool({ name: 'say', arguments: {} });
    expect(called.isError).toBe(true);
    expect(textOf(called)).toBe('That ask is over');
    await client.close();
  });

  it("says lolPing isn't running after a bye on the token", async () => {
    const app = new FakeApp((m, send) => {
      if (m.t === 'hello') send({ t: 'bye', reason: 'token' });
    });
    const { client } = await rig({ app });
    const called = await client.callTool({ name: 'say', arguments: {} });
    expect(textOf(called)).toBe("lolPing isn't running");
    await client.close();
  });

  it('matches answers to calls by id, whatever order they arrive in', async () => {
    const held: Extract<ToBridgeApp, { t: 'call' }>[] = [];
    const app = new FakeApp((m, send) => {
      if (m.t !== 'call') return;
      held.push(m);
      if (held.length < 2) return;
      for (const c of [...held].reverse()) {
        send({ t: 'result', id: c.id, content: [{ text: `for ${c.name}` }], isError: false });
      }
    });
    const { client } = await rig({ app });
    const [a, b] = await Promise.all([
      client.callTool({ name: 'say', arguments: {} }),
      client.callTool({ name: 'ping', arguments: {} }),
    ]);
    expect(textOf(a)).toBe('for say');
    expect(textOf(b)).toBe('for ping');
    await client.close();
  });

  it('passes an image result through as MCP image content', async () => {
    const content: BridgeContent[] = [{ text: 'here' }, { image: { mime: 'image/png', data: 'AAEC' } }];
    const app = new FakeApp((m, send) => {
      if (m.t === 'call') send({ t: 'result', id: m.id, content, isError: true });
    });
    const { client } = await rig({ app });
    const called = await client.callTool({ name: 'look', arguments: {} });
    expect(called.isError).toBe(true);
    expect(called.content).toEqual([
      { type: 'text', text: 'here' },
      { type: 'image', mimeType: 'image/png', data: 'AAEC' },
    ]);
    await client.close();
  });

  it('answers an unknown method with method not found', async () => {
    const toBridge = new PassThrough();
    const fromBridge = new PassThrough();
    void runBridge({
      stdin: toBridge, stdout: fromBridge, env: {}, readToken: async () => TOKEN,
      connect: () => new PassThrough(),
    });
    const replies: string[] = [];
    fromBridge.setEncoding('utf8');
    fromBridge.on('data', (c: string) => replies.push(c));
    toBridge.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'server/discover' })}\n`);
    while (replies.length === 0) await new Promise<void>((r) => setImmediate(r));
    const reply = JSON.parse(replies.join('')) as { id: number; error: { code: number } };
    expect(reply.id).toBe(1);
    expect(reply.error.code).toBe(-32601);
  });

  it('reports the server as lolping with the package version', async () => {
    const { client } = await rig();
    expect(client.getServerVersion()).toMatchObject({ name: 'lolping', version: pkg.version });
    await client.close();
  });

  it('finishes when the agent closes stdin', async () => {
    const { client, done } = await rig();
    await client.close();
    await expect(done).resolves.toBeUndefined();
  });
});

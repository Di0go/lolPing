import { randomBytes } from 'node:crypto';
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BridgeServer, bridgePath, writeTokenFile, type BridgeHandler, type BridgeSession,
} from '../../../src/main/mcp/bridgeServer';
import {
  BRIDGE_LINE_MAX, BRIDGE_VERSION, encodeLine, parseFromApp,
  type BridgeContent, type FromBridgeApp, type ToBridgeApp,
} from '../../../src/shared/teammate/bridgeProtocol';
import type { ToolDef } from '../../../src/shared/teammate/tools';

const isWin = process.platform === 'win32';
const SOCKET_PATH_MAX = 103;
const ASK = `ask-7.${'0f'.repeat(16)}`;
const TOOLS: ToolDef[] = [{ name: 'look', description: 'Look at the screen.', parameters: { type: 'object' } }];

/** Polls without timers, so it still works while setTimeout is faked. */
async function until(cond: () => boolean): Promise<void> {
  while (!cond()) await new Promise<void>((r) => setImmediate(r));
}

/** A box the handler fills from inside a closure, so reads of it are not narrowed to null. */
interface Seen { signal: AbortSignal | null }

class Client {
  readonly lines: FromBridgeApp[] = [];
  closed = false;
  private partial = '';
  private constructor(readonly socket: net.Socket) {
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      this.partial += chunk;
      const parts = this.partial.split('\n');
      this.partial = parts.pop() ?? '';
      for (const p of parts) {
        const m = parseFromApp(p);
        if (m) this.lines.push(m);
      }
    });
    socket.on('error', () => undefined);
    socket.on('close', () => { this.closed = true; });
  }
  static async connect(p: string): Promise<Client> {
    const socket = net.connect(p);
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
    });
    return new Client(socket);
  }
  send(m: ToBridgeApp): void {
    this.socket.write(encodeLine(m));
  }
  async line(n: number): Promise<FromBridgeApp> {
    await until(() => this.lines.length > n || this.closed);
    const m = this.lines[n];
    if (!m) throw new Error(`no line ${n}`);
    return m;
  }
  async waitClosed(): Promise<void> {
    await until(() => this.closed);
  }
}

describe('BridgeServer', () => {
  let dir: string;
  let sockPath: string;
  let tokens: string[];
  let handler: BridgeHandler;
  let hellos: BridgeSession[];
  let server: BridgeServer;
  let clients: Client[];
  let callImpl: BridgeHandler['call'];

  const make = (): BridgeServer => new BridgeServer({
    path: sockPath,
    tokenFile: path.join(dir, 'mcp-token'),
    handler,
    now: () => 0,
    random: (n) => randomBytes(n),
    writeToken: async (_file, token) => { tokens.push(token); },
  });
  const connect = async (): Promise<Client> => {
    const c = await Client.connect(sockPath);
    clients.push(c);
    return c;
  };
  const hello = (token: string, over: Partial<Extract<ToBridgeApp, { t: 'hello' }>> = {}): ToBridgeApp => ({
    t: 'hello', v: BRIDGE_VERSION, token, ask: ASK, client: { name: 'claude-code', version: '1.2.3' }, ...over,
  });
  const token = (): string => tokens[tokens.length - 1] ?? '';
  /** A call that never finishes and records its signal. */
  const hangingCall = (): Seen => {
    const seen: Seen = { signal: null };
    callImpl = (_s, _n, _a, signal) => {
      seen.signal = signal;
      return new Promise(() => undefined);
    };
    return seen;
  };

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'lolping-bridge-'));
    // macOS allows 103 bytes in a socket path, and its temp folder is already long.
    if (!isWin && Buffer.byteLength(path.join(dir, 'mcp.sock')) > SOCKET_PATH_MAX) {
      await rm(dir, { recursive: true, force: true });
      dir = await mkdtemp(path.join('/tmp', 'lp-'));
    }
    sockPath = isWin ? `\\\\.\\pipe\\lolping-test-${randomBytes(8).toString('hex')}` : path.join(dir, 'mcp.sock');
    tokens = [];
    hellos = [];
    clients = [];
    callImpl = async () => ({ content: [{ text: 'ok' }], isError: false });
    handler = {
      hello: (s) => { hellos.push(s); },
      list: () => TOOLS,
      call: (s, name, args, signal) => callImpl(s, name, args, signal),
    };
    server = make();
    await server.start();
  });

  afterEach(async () => {
    vi.useRealTimers();
    for (const c of clients) c.socket.destroy();
    await server.stop();
    await rm(dir, { recursive: true, force: true });
  });

  it('answers list and call for a session with the token', async () => {
    callImpl = async (s, name, args) => ({
      content: [{ text: `${s.client.name}:${name}:${JSON.stringify(args)}` }, { image: { mime: 'image/png', data: 'AAAA' } }],
      isError: false,
    });
    const c = await connect();
    c.send(hello(token()));
    c.send({ t: 'list', id: 1 });
    expect(await c.line(0)).toEqual({ t: 'tools', id: 1, tools: TOOLS });
    c.send({ t: 'call', id: 2, name: 'look', args: { a: 1 } });
    expect(await c.line(1)).toEqual({
      t: 'result', id: 2, isError: false,
      content: [{ text: 'claude-code:look:{"a":1}' }, { image: { mime: 'image/png', data: 'AAAA' } }],
    });
    expect(hellos).toEqual([{ ask: ASK, client: { name: 'claude-code', version: '1.2.3' } }]);
  });

  it('closes a connection without the token', async () => {
    const wrong = await connect();
    wrong.send(hello('0'.repeat(64)));
    wrong.send(hello(token())); // sent right behind the bad one: the connection is already finished
    expect(await wrong.line(0)).toEqual({ t: 'bye', reason: 'token' });
    await wrong.waitClosed();
    expect(wrong.lines).toHaveLength(1);

    const early = await connect();
    early.send({ t: 'list', id: 1 });
    await early.waitClosed();
    expect(early.lines).toEqual([]);
    expect(hellos).toEqual([]);
  });

  it('says bye for a bridge with another version', async () => {
    const c = await connect();
    c.send(hello(token(), { v: BRIDGE_VERSION + 1 }));
    expect(await c.line(0)).toEqual({ t: 'bye', reason: 'version' });
    await c.waitClosed();
    expect(hellos).toEqual([]);
  });

  it('closes a connection that sends a line it cannot read', async () => {
    const c = await connect();
    c.socket.write('not json\n');
    await c.waitClosed();
    expect(c.lines).toEqual([]);
  });

  it('closes a connection that sends a second hello', async () => {
    const c = await connect();
    c.send(hello(token()));
    c.send(hello(token()));
    await c.waitClosed();
  });

  it('closes a connection that sends nothing for 2 s', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const c = await connect();
    await until(() => server.connections === 1);
    vi.advanceTimersByTime(1999);
    expect(c.closed).toBe(false);
    vi.advanceTimersByTime(1);
    await c.waitClosed();
    expect(server.connections).toBe(0);
  });

  it('keeps a connection open once it has said hello', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const c = await connect();
    c.send(hello(token()));
    await until(() => hellos.length === 1);
    vi.advanceTimersByTime(10_000);
    c.send({ t: 'list', id: 1 });
    expect(await c.line(0)).toEqual({ t: 'tools', id: 1, tools: TOOLS });
  });

  it('closes a connection whose line grows past the limit', async () => {
    const c = await connect();
    c.send(hello(token()));
    await until(() => hellos.length === 1);
    c.socket.write('x'.repeat(BRIDGE_LINE_MAX + 1));
    await c.waitClosed();
  });

  it('aborts a pending call when its connection closes', async () => {
    const seen = hangingCall();
    const c = await connect();
    c.send(hello(token()));
    c.send({ t: 'call', id: 1, name: 'look', args: {} });
    await until(() => seen.signal !== null);
    expect(seen.signal?.aborted).toBe(false);
    c.socket.destroy();
    await until(() => seen.signal?.aborted === true);
    await until(() => server.connections === 0);
  });

  it('aborts pending calls and closes every connection on stop', async () => {
    const seen = hangingCall();
    const c = await connect();
    c.send(hello(token()));
    c.send({ t: 'call', id: 1, name: 'look', args: {} });
    await until(() => seen.signal !== null);
    await server.stop();
    expect(seen.signal?.aborted).toBe(true);
    await c.waitClosed();
    expect(server.connections).toBe(0);
  });

  it('runs calls on one connection at the same time and answers each by its id', async () => {
    const releases = new Map<string, (content: BridgeContent[]) => void>();
    callImpl = (_s, name) => new Promise((resolve) => {
      releases.set(name, (content) => resolve({ content, isError: false }));
    });
    const c = await connect();
    c.send(hello(token()));
    c.send({ t: 'call', id: 1, name: 'slow', args: {} });
    c.send({ t: 'call', id: 2, name: 'fast', args: {} });
    await until(() => releases.size === 2);
    releases.get('fast')?.([{ text: 'fast done' }]);
    expect(await c.line(0)).toEqual({ t: 'result', id: 2, content: [{ text: 'fast done' }], isError: false });
    releases.get('slow')?.([{ text: 'slow done' }]);
    expect(await c.line(1)).toEqual({ t: 'result', id: 1, content: [{ text: 'slow done' }], isError: false });
  });

  it('answers a failed call with an error result when the handler throws', async () => {
    callImpl = async () => { throw new Error('boom'); };
    const c = await connect();
    c.send(hello(token()));
    c.send({ t: 'call', id: 4, name: 'look', args: {} });
    expect(await c.line(0)).toEqual({
      t: 'result', id: 4, content: [{ text: 'lolPing failed to run that.' }], isError: true,
    });
  });

  it('counts open connections, with or without hello', async () => {
    expect(server.connections).toBe(0);
    const a = await connect();
    const b = await connect();
    await until(() => server.connections === 2);
    a.send(hello(token()));
    b.socket.destroy();
    await until(() => server.connections === 1);
    a.socket.destroy();
    await until(() => server.connections === 0);
  });

  it('writes a fresh token on every start', async () => {
    const first = tokens[0] ?? '';
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    await server.stop();
    server = make();
    await server.start();
    expect(tokens).toHaveLength(2);
    expect(tokens[1]).toMatch(/^[0-9a-f]{64}$/);
    expect(tokens[1]).not.toBe(first);
    // The old token no longer opens a session.
    const c = await connect();
    c.send(hello(first));
    expect(await c.line(0)).toEqual({ t: 'bye', reason: 'token' });
  });

  it.skipIf(isWin)('replaces a stale socket file and keeps the socket private to the user', async () => {
    await server.stop();
    await writeFile(sockPath, 'left over from a crash');
    server = make();
    await server.start();
    expect((await stat(sockPath)).mode & 0o777).toBe(0o600);
    const c = await connect();
    c.send(hello(token()));
    c.send({ t: 'list', id: 1 });
    expect(await c.line(0)).toEqual({ t: 'tools', id: 1, tools: TOOLS });
  });

  it('names the pipe per user on Windows and puts the socket in userData elsewhere', () => {
    const a = bridgePath('win', 'C:\\Users\\a\\AppData\\Roaming\\lolPing', 'alice');
    const b = bridgePath('win', 'C:\\Users\\a\\AppData\\Roaming\\lolPing', 'bob');
    expect(a).toMatch(/^\\\\\.\\pipe\\lolping-[0-9a-f]{16}$/);
    expect(b).toMatch(/^\\\\\.\\pipe\\lolping-[0-9a-f]{16}$/);
    expect(a).not.toBe(b);
    expect(bridgePath('win', 'x', 'alice')).toBe(a);
    expect(bridgePath('mac', '/Users/a/Library/Application Support/lolPing', 'alice'))
      .toBe(path.join('/Users/a/Library/Application Support/lolPing', 'mcp.sock'));
    expect(bridgePath('linux', '/home/a/.config/lolPing', 'alice')).toBe(path.join('/home/a/.config/lolPing', 'mcp.sock'));
  });

  it.skipIf(isWin)('writes the token file private to the user even over a file left with another mode', async () => {
    const tokenFile = path.join(dir, 'mcp-token');
    await writeFile(tokenFile, 'old', { mode: 0o644 });
    await chmod(tokenFile, 0o644);
    await writeTokenFile(tokenFile, 'new');
    expect((await stat(tokenFile)).mode & 0o777).toBe(0o600);
    expect(await readFile(tokenFile, 'utf8')).toBe('new');
  });

  it.skipIf(isWin)('listens on the short fallback socket when userData is too deep for a socket path', async () => {
    await server.stop();
    const deep = path.join(dir, 'd'.repeat(120), 'lolPing');
    const fallback = bridgePath('mac', deep, 'alice');
    expect(fallback).not.toContain('d'.repeat(120));
    expect(Buffer.byteLength(fallback)).toBeLessThanOrEqual(SOCKET_PATH_MAX);
    sockPath = fallback;
    server = make();
    await server.start();
    try {
      expect((await stat(fallback)).mode & 0o777).toBe(0o600);
      const c = await connect();
      c.send(hello(token()));
      c.send({ t: 'list', id: 1 });
      expect(await c.line(0)).toEqual({ t: 'tools', id: 1, tools: TOOLS });
    } finally {
      for (const c of clients) c.socket.destroy();
      await server.stop();
      await rm(fallback, { force: true });
    }
  });
});

describe('bridgePath for a long userData folder', () => {
  const TMP = path.join('/var/folders/zz/abc', 'T');
  /** A userData folder whose socket path `<it>/mcp.sock` is exactly `bytes` long. */
  const userDataFor = (bytes: number): string => `/${'a'.repeat(bytes - '/mcp.sock'.length - 1)}`;

  it('keeps mcp.sock in userData up to 103 bytes on macOS', () => {
    const userData = userDataFor(103);
    expect(bridgePath('mac', userData, 'alice', TMP)).toBe(path.join(userData, 'mcp.sock'));
  });

  it('falls back to a socket in the temp folder at 104 bytes on macOS', () => {
    const userData = userDataFor(104);
    const p = bridgePath('mac', userData, 'alice', TMP);
    expect(p).toMatch(/lolping-[0-9a-f]{16}\.sock$/);
    expect(path.dirname(p)).toBe(TMP);
  });

  it('counts bytes, not characters', () => {
    const userData = `/Users/${'é'.repeat(50)}/Library/Application Support/lolPing`;
    expect(userData.length + '/mcp.sock'.length).toBeLessThan(104);
    expect(path.dirname(bridgePath('mac', userData, 'x', TMP))).toBe(TMP);
  });

  it('allows 107 bytes on Linux', () => {
    expect(bridgePath('linux', userDataFor(107), 'alice', TMP)).toBe(path.join(userDataFor(107), 'mcp.sock'));
    expect(path.dirname(bridgePath('linux', userDataFor(108), 'alice', TMP))).toBe(TMP);
  });

  it('gives the same fallback to both sides and another one to another folder', () => {
    const a = `/${'a'.repeat(150)}`;
    const b = `/${'b'.repeat(150)}`;
    expect(bridgePath('mac', a, 'alice', TMP)).toBe(bridgePath('mac', a, 'alice', TMP));
    expect(bridgePath('mac', a, 'alice', TMP)).not.toBe(bridgePath('mac', b, 'alice', TMP));
    expect(bridgePath('mac', a, 'alice', TMP)).not.toBe(bridgePath('mac', a, 'bob', TMP));
  });

  it('leaves the Windows pipe alone however long the folder is', () => {
    const p = bridgePath('win', `C:\\${'a'.repeat(200)}`, 'alice', TMP);
    expect(p).toMatch(/^\\\\\.\\pipe\\lolping-[0-9a-f]{16}$/);
  });
});

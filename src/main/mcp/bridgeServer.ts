import { createHash, timingSafeEqual } from 'node:crypto';
import { chmod, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { platformOf, type Platform } from '../../shared/platform';
import {
  BRIDGE_LINE_MAX, BRIDGE_VERSION, encodeLine, parseToApp,
  type BridgeContent, type FromBridgeApp,
} from '../../shared/teammate/bridgeProtocol';
import type { ToolDef } from '../../shared/teammate/tools';

/** How long a new connection has to say hello before the app drops it. */
const HELLO_DEADLINE_MS = 2000;
const TOKEN_BYTES = 32;
const PIPE_NAME_HEX = 16;
// sun_path holds 104 bytes on macOS and 108 on Linux, one of them for the closing NUL.
const SOCKET_PATH_MAX: Record<'mac' | 'linux', number> = { mac: 103, linux: 107 };
const FAILED_CALL: BridgeContent[] = [{ text: 'lolPing failed to run that.' }];

export interface BridgeSession { ask: string | null; client: { name: string; version: string } }

export interface BridgeHandler {
  /** A session said hello. Not yet "received": dsh opens a probe connection first and closes it (spec §16). */
  hello(s: BridgeSession): void;
  /** The session's first tools/list: Task 4.8 marks the ask received here. */
  list(s: BridgeSession): ToolDef[];
  call(
    s: BridgeSession, name: string, args: unknown, signal: AbortSignal,
  ): Promise<{ content: BridgeContent[]; isError: boolean }>;
}

export interface BridgeServerDeps {
  path: string;
  tokenFile: string;
  handler: BridgeHandler;
  now: () => number;
  random: (n: number) => Buffer;
  writeToken: (file: string, token: string) => Promise<void>;
}

/**
 * Where the bridge finds the app: a per-user pipe on Windows, a socket in the user's own data folder elsewhere. When
 * that path is too long for a socket, a short one in the temp folder; both sides work it out from the same inputs.
 */
export function bridgePath(platform: Platform, userData: string, username: string, tmp: string = tmpdir()): string {
  if (platform === 'win') {
    const id = createHash('sha256').update(username).digest('hex').slice(0, PIPE_NAME_HEX);
    return `\\\\.\\pipe\\lolping-${id}`;
  }
  const inUserData = path.join(userData, 'mcp.sock');
  if (Buffer.byteLength(inUserData) <= SOCKET_PATH_MAX[platform]) return inUserData;
  const id = createHash('sha256').update(JSON.stringify([username, userData])).digest('hex').slice(0, PIPE_NAME_HEX);
  return path.join(tmp, `lolping-${id}.sock`);
}

/** Writes the token so only the user can read it, even over a file an older run left with another mode. */
export async function writeTokenFile(file: string, token: string): Promise<void> {
  await writeFile(file, token, { mode: 0o600 });
  // A write's mode only counts when it creates the file. Windows has no such mode to set.
  if (platformOf(process.platform) !== 'win') await chmod(file, 0o600);
}

const sameToken = (given: string, expected: string): boolean => {
  const a = Buffer.from(given, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
};

/** The app's end of the MCP bridge: a local pipe that relays tools/list and tools/call to the handler. */
export class BridgeServer {
  private server: net.Server | null = null;
  private token = '';
  private readonly sockets = new Set<net.Socket>();
  private readonly aborts = new Set<AbortController>();

  constructor(private readonly deps: BridgeServerDeps) {}

  get connections(): number {
    return this.sockets.size;
  }

  async start(): Promise<void> {
    this.token = this.deps.random(TOKEN_BYTES).toString('hex');
    await this.deps.writeToken(this.deps.tokenFile, this.token);
    const posix = platformOf(process.platform) !== 'win';
    // A socket file left by a crashed run would make listen fail with EADDRINUSE.
    if (posix) await rm(this.deps.path, { force: true });
    const server = net.createServer((socket) => this.accept(socket));
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.deps.path, () => {
        server.off('error', reject);
        resolve();
      });
    });
    this.server = server;
    if (posix) await chmod(this.deps.path, 0o600);
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    for (const a of this.aborts) a.abort();
    for (const s of this.sockets) s.destroy();
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private accept(socket: net.Socket): void {
    this.sockets.add(socket);
    socket.setEncoding('utf8');
    let session: BridgeSession | null = null;
    let buffered = '';
    let finished = false; // after bye, anything more the peer sends is ignored
    const pending = new Set<AbortController>();
    const send = (m: FromBridgeApp): void => {
      if (!socket.destroyed) socket.write(encodeLine(m));
    };
    const bye = (reason: 'token' | 'version'): void => {
      send({ t: 'bye', reason });
      socket.end();
      finished = true;
    };
    const helloTimer = setTimeout(() => socket.destroy(), HELLO_DEADLINE_MS);

    const handleLine = (line: string): void => {
      const m = parseToApp(line);
      if (!m) return void socket.destroy();
      if (!session) {
        if (m.t !== 'hello') return void socket.destroy();
        if (!sameToken(m.token, this.token)) return bye('token');
        if (m.v !== BRIDGE_VERSION) return bye('version');
        clearTimeout(helloTimer);
        session = { ask: m.ask, client: m.client };
        this.deps.handler.hello(session);
        return;
      }
      const s = session;
      if (m.t === 'hello') return void socket.destroy();
      if (m.t === 'list') {
        let tools: ToolDef[];
        try {
          tools = this.deps.handler.list(s);
        } catch {
          return void socket.destroy();
        }
        send({ t: 'tools', id: m.id, tools });
        return;
      }
      const abort = new AbortController();
      pending.add(abort);
      this.aborts.add(abort);
      void Promise.resolve().then(() => this.deps.handler.call(s, m.name, m.args, abort.signal))
        .then(
          (r) => send({ t: 'result', id: m.id, content: r.content, isError: r.isError }),
          () => send({ t: 'result', id: m.id, content: FAILED_CALL, isError: true }),
        )
        .finally(() => {
          pending.delete(abort);
          this.aborts.delete(abort);
        });
    };

    socket.on('data', (chunk: string) => {
      if (finished) return;
      buffered += chunk;
      let nl = buffered.indexOf('\n');
      while (nl !== -1 && !finished && !socket.destroyed) {
        const line = buffered.slice(0, nl);
        buffered = buffered.slice(nl + 1);
        handleLine(line);
        nl = buffered.indexOf('\n');
      }
      if (buffered.length > BRIDGE_LINE_MAX) socket.destroy();
    });
    // The peer going away mid-write is normal; the close handler does the cleanup.
    socket.on('error', () => undefined);
    socket.on('close', () => {
      clearTimeout(helloTimer);
      for (const a of pending) {
        a.abort();
        this.aborts.delete(a);
      }
      pending.clear();
      this.sockets.delete(socket);
    });
  }
}

import { createHash, timingSafeEqual } from 'node:crypto';
import { chmod, lstat, mkdir, rm, writeFile } from 'node:fs/promises';
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
  /** The folder the socket sits in when it must be made private first; see bridgeLocation. */
  privateDir?: string | null;
  handler: BridgeHandler;
  random: (n: number) => Buffer;
  writeToken: (file: string, token: string) => Promise<void>;
}

/** What bridgeLocation reads from the machine; a test passes its own. */
export interface SocketSurroundings {
  tmp?: string;
  /** $XDG_RUNTIME_DIR: on Linux a folder the system makes private to the user. */
  runtimeDir?: string;
  /** The user's id; null where there is none, and then the folder is named by a hash. */
  uid?: number | null;
}

export interface BridgeLocation {
  path: string;
  /** A folder the app must make private (0700, owned by the user) before it listens, or null. */
  privateDir: string | null;
}

/**
 * Where the bridge finds the app: a per-user pipe on Windows, a socket in the user's own data folder elsewhere. When
 * that path is too long for a socket, a short one: in $TMPDIR on macOS (a per-user folder), in $XDG_RUNTIME_DIR on
 * Linux or else a folder of the user's own in /tmp, which is shared and so is never used for the socket itself.
 * Both sides work it out from the same inputs.
 */
export function bridgeLocation(platform: Platform, userData: string, username: string, around: SocketSurroundings = {}):
  BridgeLocation {
  if (platform === 'win') {
    const id = createHash('sha256').update(username).digest('hex').slice(0, PIPE_NAME_HEX);
    return { path: `\\\\.\\pipe\\lolping-${id}`, privateDir: null };
  }
  const inUserData = path.join(userData, 'mcp.sock');
  if (Buffer.byteLength(inUserData) <= SOCKET_PATH_MAX[platform]) return { path: inUserData, privateDir: null };
  const tmp = around.tmp ?? tmpdir();
  const id = createHash('sha256').update(JSON.stringify([username, userData])).digest('hex').slice(0, PIPE_NAME_HEX);
  if (platform === 'mac') return { path: path.join(tmp, `lolping-${id}.sock`), privateDir: null };
  const runtime = 'runtimeDir' in around ? around.runtimeDir : process.env.XDG_RUNTIME_DIR;
  if (runtime !== undefined && runtime !== '' && path.isAbsolute(runtime)) {
    return { path: path.join(runtime, `lolping-${id}.sock`), privateDir: null };
  }
  const uid = 'uid' in around ? around.uid ?? null : process.getuid?.() ?? null;
  const dir = path.join(tmp, `lolping-${uid ?? id}`);
  return { path: path.join(dir, `${id}.sock`), privateDir: dir };
}

export const bridgePath = (
  platform: Platform, userData: string, username: string, around?: SocketSurroundings,
): string => bridgeLocation(platform, userData, username, around).path;

/** Makes `dir` if it isn't there and throws unless it is a real folder owned by `uid` that only `uid` can use. */
export async function ensurePrivateDir(dir: string, uid: number | null = process.getuid?.() ?? null): Promise<void> {
  try {
    await mkdir(dir, { mode: 0o700 });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
  }
  // lstat, so a link someone else put there is not followed.
  const info = await lstat(dir);
  if (!info.isDirectory() || (uid !== null && info.uid !== uid) || (info.mode & 0o777) !== 0o700) {
    throw new Error(`${dir} is not a private folder of this user`);
  }
}

/** Writes the token so only the user can read it, even over a file an older run left with another mode. */
export async function writeTokenFile(file: string, token: string): Promise<void> {
  if (platformOf(process.platform) !== 'win') {
    // Before the write, so the new token never sits in a file others can read. A write's mode only counts on creation.
    await chmod(file, 0o600).catch((e: NodeJS.ErrnoException) => {
      if (e.code !== 'ENOENT') throw e;
    });
  }
  await writeFile(file, token, { mode: 0o600 });
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

  constructor(private readonly deps: BridgeServerDeps) {}

  get connections(): number {
    return this.sockets.size;
  }

  async start(): Promise<void> {
    this.token = this.deps.random(TOKEN_BYTES).toString('hex');
    await this.deps.writeToken(this.deps.tokenFile, this.token);
    const posix = platformOf(process.platform) !== 'win';
    if (posix && this.deps.privateDir) await ensurePrivateDir(this.deps.privateDir);
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
    // Without a listener a later error, such as EMFILE on accept, would be an uncaught exception in main.
    server.on('error', (err) => console.warn('[teammate] bridge:', err));
    this.server = server;
    if (posix) await chmod(this.deps.path, 0o600);
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    // Each connection's close aborts its own pending calls; stop is done once they all have.
    const closed = [...this.sockets].map((s) => new Promise<void>((resolve) => {
      s.once('close', () => resolve());
      s.destroy();
    }));
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    await Promise.all(closed);
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
      void Promise.resolve().then(() => this.deps.handler.call(s, m.name, m.args, abort.signal))
        .then(
          (r) => {
            try {
              send({ t: 'result', id: m.id, content: r.content, isError: r.isError });
            } catch (err) {
              // A result that can't be encoded still answers the call, so the agent isn't left waiting.
              console.warn('[teammate] bridge:', err);
              send({ t: 'result', id: m.id, content: FAILED_CALL, isError: true });
            }
          },
          () => send({ t: 'result', id: m.id, content: FAILED_CALL, isError: true }),
        )
        .finally(() => pending.delete(abort));
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
      for (const a of pending) a.abort();
      pending.clear();
      this.sockets.delete(socket);
    });
  }
}

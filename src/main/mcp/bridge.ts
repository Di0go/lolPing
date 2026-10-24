import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { readFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { Duplex, Readable, Writable } from 'node:stream';
import { platformOf } from '../../shared/platform';
import {
  BRIDGE_LINE_MAX, BRIDGE_VERSION, encodeLine, parseFromApp,
  type BridgeContent, type FromBridgeApp, type ToBridgeApp,
} from '../../shared/teammate/bridgeProtocol';
import { toolDefs, type ToolDef } from '../../shared/teammate/tools';
import pkg from '../../../package.json';
import { dataDirFor } from './bridgeCommand';
import { bridgePath } from './bridgeServer';

const CLIENT_NAME_MAX = 64;
const CLIENT_VERSION_MAX = 32;
const DISPLAY_TOOLS = ['say', 'ping', 'emote', 'answer'];
const NOT_RUNNING = "lolPing isn't running";
const ASK_OVER = 'That ask is over';

/** The four display tools, for when lolPing can't be reached: an agent still sees what it could call. */
const fallbackTools = (): ToolDef[] =>
  toolDefs({ emotes: true, spots: 0, file: false, look: false, kind: 'answer', form: false, selection: false })
    .filter((d) => DISPLAY_TOOLS.includes(d.name));

const toMcpContent = (c: BridgeContent) =>
  'text' in c
    ? { type: 'text' as const, text: c.text }
    : { type: 'image' as const, mimeType: c.image.mime, data: c.image.data };

const failure = (text: string) => ({ content: [{ type: 'text' as const, text }], isError: true });

/** One connection to the app. `pending` holds the requests waiting for an answer, by id. */
interface Link {
  socket: Duplex;
  pending: Map<number, (answer: FromBridgeApp | null) => void>;
}

/** Runs the stdio MCP server; `connect` opens the pipe (net.connect in the real entry). */
export async function runBridge(deps: {
  stdin: Readable;
  stdout: Writable;
  env: NodeJS.ProcessEnv;
  readToken: () => Promise<string>;
  connect: () => Duplex;
}): Promise<void> {
  const server = new Server({ name: 'lolping', version: pkg.version }, { capabilities: { tools: {} } });
  const ask = deps.env.LOLPING_ASK || null;
  let nextId = 0;
  let active: Link | null = null;
  let opening: Promise<Link | null> | null = null;

  const forget = (l: Link): void => {
    if (active !== l) return;
    active = null;
    opening = null;
  };

  /** Connects and says hello. The pipe closing or a `bye` answers every waiting request and clears the link. */
  async function open(): Promise<Link | null> {
    let token: string;
    try {
      token = (await deps.readToken()).trim();
    } catch {
      return null;
    }
    const info = server.getClientVersion();
    const client = {
      name: (info?.name || 'unknown').slice(0, CLIENT_NAME_MAX),
      version: (info?.version || 'unknown').slice(0, CLIENT_VERSION_MAX),
    };
    const socket = deps.connect();
    const link: Link = { socket, pending: new Map() };
    const finish = (answer: FromBridgeApp | null): void => {
      forget(link);
      const waiting = [...link.pending.values()];
      link.pending.clear();
      for (const resolve of waiting) resolve(answer);
      socket.destroy();
    };
    let buffered = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      buffered += chunk;
      for (let nl = buffered.indexOf('\n'); nl !== -1; nl = buffered.indexOf('\n')) {
        const line = buffered.slice(0, nl);
        buffered = buffered.slice(nl + 1);
        const m = parseFromApp(line);
        if (!m) return finish(null);
        if (m.t === 'bye') return finish(m);
        const resolve = link.pending.get(m.id);
        link.pending.delete(m.id);
        resolve?.(m);
      }
      if (buffered.length > BRIDGE_LINE_MAX) finish(null);
    });
    socket.on('error', () => finish(null));
    socket.on('close', () => finish(null));
    active = link;
    const hello: ToBridgeApp = { t: 'hello', v: BRIDGE_VERSION, token, ask, client };
    socket.write(encodeLine(hello));
    return link;
  }

  function link(): Promise<Link | null> {
    opening ??= open().then((l) => {
      if (!l) opening = null; // nothing opened: the next request tries again
      return l;
    });
    return opening;
  }

  /** The app's answer to one request, or null when lolPing can't be reached. */
  async function request(build: (id: number) => ToBridgeApp): Promise<FromBridgeApp | null> {
    const l = await link();
    if (!l) return null;
    if (l.socket.destroyed) {
      forget(l); // its error event may not have fired yet, and the next request must open a new one
      return null;
    }
    const id = nextId++;
    return new Promise((resolve) => {
      l.pending.set(id, resolve);
      l.socket.write(encodeLine(build(id)));
    });
  }

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const answer = await request((id) => ({ t: 'list', id }));
    const tools = answer?.t === 'tools' ? answer.tools : fallbackTools();
    return {
      tools: tools.map((t) => ({
        name: t.name, description: t.description, inputSchema: { ...t.parameters, type: 'object' as const },
      })),
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    const answer = await request((id) => ({ t: 'call', id, name, args: args ?? {} }));
    if (answer?.t === 'result') return { content: answer.content.map(toMcpContent), isError: answer.isError };
    return failure(answer?.t === 'bye' && answer.reason === 'over' ? ASK_OVER : NOT_RUNNING);
  });

  const closed = new Promise<void>((resolve) => {
    server.onclose = () => {
      active?.socket.destroy();
      resolve();
    };
  });
  // StdioServerTransport doesn't notice the agent closing its end.
  deps.stdin.once('end', () => void server.close());
  await server.connect(new StdioServerTransport(deps.stdin, deps.stdout));
  return closed;
}

function main(): void {
  const env = process.env;
  const platform = platformOf(process.platform);
  const dataDir = env.LOLPING_DATA || dataDirFor(platform, env, os.homedir());
  const pipe = env.LOLPING_PIPE || bridgePath(platform, dataDir, os.userInfo().username);
  runBridge({
    stdin: process.stdin,
    stdout: process.stdout,
    env,
    readToken: () => readFile(path.join(dataDir, 'mcp-token'), 'utf8'),
    connect: () => net.connect(pipe),
  }).then(() => process.exit(0), () => process.exit(1));
}

// Only when started as the script (by an agent), not when the tests or the app import this file.
if (typeof require !== 'undefined' && typeof module !== 'undefined' && require.main === module) main();

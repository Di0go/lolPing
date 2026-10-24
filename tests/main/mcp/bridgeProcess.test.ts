import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { build } from 'esbuild';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { BridgeServer, bridgePath } from '../../../src/main/mcp/bridgeServer';
import { platformOf } from '../../../src/shared/platform';
import type { ToolDef } from '../../../src/shared/teammate/tools';

const SLOW = 30_000;
const ASK = `ask-7.${'0f'.repeat(16)}`;
const platform = platformOf(process.platform);
const TOOLS: ToolDef[] = [{ name: 'look', description: 'Look at the screen.', parameters: { type: 'object' } }];

// The bundle is run by plain Node (the packaged app runs it as Node through ELECTRON_RUN_AS_NODE the same way).
describe('the bridge as a separate process', () => {
  let work = '';
  let script = '';
  let required: string[] = [];
  const cleanup: (() => Promise<void>)[] = [];

  beforeAll(async () => {
    work = await mkdtemp(path.join(os.tmpdir(), 'lolping-proc-'));
    script = path.join(work, 'bridge.cjs');
    const built = await build({
      entryPoints: [path.resolve('src/main/mcp/bridge.ts')], bundle: true, platform: 'node', format: 'cjs',
      outfile: script, logLevel: 'silent', metafile: true,
    });
    required = Object.values(built.metafile.outputs).flatMap((o) => o.imports.map((i) => i.path));
  }, SLOW);

  // An agent starts the bridge with ELECTRON_RUN_AS_NODE, where `require('electron')` is only the path to the binary.
  it('needs nothing from Electron', () => {
    expect(required.filter((r) => r === 'electron' || r.startsWith('electron/'))).toEqual([]);
    expect(required.length).toBeGreaterThan(0);
  });

  afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) await fn();
  });

  afterAll(async () => {
    await rm(work, { recursive: true, force: true });
  });

  /** Starts the app's end at `listenOn`, with the token in `dataDir`, and returns the tools/call arguments it saw. */
  async function startApp(dataDir: string, listenOn: string): Promise<{ called: unknown[] }> {
    await mkdir(dataDir, { recursive: true });
    const called: unknown[] = [];
    const server = new BridgeServer({
      path: listenOn, tokenFile: path.join(dataDir, 'mcp-token'), now: Date.now, random: randomBytes,
      writeToken: (file, token) => writeFile(file, token, { mode: 0o600 }),
      handler: {
        hello: () => undefined,
        list: () => TOOLS,
        call: async (_s, name, args) => {
          called.push([name, args]);
          return { content: [{ text: 'seen' }], isError: false };
        },
      },
    });
    await server.start();
    cleanup.push(async () => {
      await server.stop();
      if (process.platform !== 'win32') await rm(listenOn, { force: true });
    });
    return { called };
  }

  async function connect(env: Record<string, string>): Promise<Client> {
    const client = new Client({ name: 'test', version: '1' });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [script], env }));
    cleanup.push(() => client.close());
    return client;
  }

  it('lists and calls tools through the pipe named in LOLPING_PIPE', async () => {
    const data = path.join(work, 'data-a');
    const pipe = process.platform === 'win32'
      ? bridgePath('win', work, randomBytes(6).toString('hex')) : path.join(work, 'a.sock');
    const { called } = await startApp(data, pipe);
    const client = await connect({ LOLPING_DATA: data, LOLPING_PIPE: pipe, LOLPING_ASK: ASK });
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(['look']);
    const r = await client.callTool({ name: 'look', arguments: { x: 1 } });
    expect(r.content).toEqual([{ type: 'text', text: 'seen' }]);
    expect(called).toEqual([['look', { x: 1 }]]);
  }, SLOW);

  it('finds the app by itself from LOLPING_DATA when no pipe is given', async () => {
    const data = path.join(work, 'data-b');
    await startApp(data, bridgePath(platform, data, os.userInfo().username));
    const client = await connect({ LOLPING_DATA: data });
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(['look']);
  }, SLOW);

  it.runIf(process.platform !== 'win32')('finds the fallback socket when userData is too deep for a socket path', async () => {
    const data = path.join(work, 'd'.repeat(120), 'lolPing');
    const listenOn = bridgePath(platform, data, os.userInfo().username);
    expect(listenOn).not.toContain(data);
    await startApp(data, listenOn);
    // The client passes only a few variables on; os.tmpdir() reads TMPDIR, and the fallback lives there.
    const client = await connect({ LOLPING_DATA: data, TMPDIR: os.tmpdir() });
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(['look']);
  }, SLOW);
});

import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bridgeCommand } from '../../../src/main/mcp/bridgeCommand';
import { BridgeServer } from '../../../src/main/mcp/bridgeServer';
import { AgentRunner, killProcessTree } from '../../../src/main/teammate/agents/runner';
import { AskController, bridgeHandler, type AskDeps } from '../../../src/main/teammate/askController';
import { platformOf } from '../../../src/shared/platform';
import { DEFAULT_SETTINGS, type Settings } from '../../../src/shared/settings';
import { zoomRect } from '../../../src/shared/teammate/coords';
import { DEFAULT_TEAMMATE, type AgentProfile } from '../../../src/shared/teammate/settings';
import type { BubbleState } from '../../../src/shared/teammateIpc';

const FAKE = path.resolve('tests/main/fixtures/fakeAgent.mjs');
const platform = platformOf(process.platform);
const DISPLAY = { x: 0, y: 0, w: 3200, h: 2000 };
// A JPEG's start and end markers: enough for a file the controller reads and the agent is pointed at.
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);

let dir = '';
let bridgeJs = '';

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'lolping-e2e-'));
  bridgeJs = path.join(dir, 'bridge.cjs');
  // The bridge as electron-vite builds it: one CommonJS file with the SDK inside, run here by plain Node.
  await build({
    entryPoints: [path.resolve('src/main/mcp/bridge.ts')], outfile: bridgeJs, platform: 'node', format: 'cjs',
    bundle: true, logLevel: 'silent',
  });
}, 60_000);

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function until(ok: () => boolean, what: string): Promise<void> {
  const end = Date.now() + 20_000;
  while (!ok()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe('an agent answering an ask', () => {
  it('an agent\'s say reaches the bubble through the bridge', async () => {
    const pipe = platform === 'win'
      ? `\\\\.\\pipe\\lolping-e2e-${randomBytes(8).toString('hex')}`
      : path.join(dir, 'mcp.sock');
    const profile: AgentProfile = {
      id: 'fake', kind: 'agent', name: 'Fake', tagColor: 1, tagColorCustom: null, preset: 'custom',
      command: process.execPath, customArgs: [FAKE, '--answer-over-mcp', '{mcpConfig}'],
      folder: { kind: 'fixed', path: dir }, timeoutS: 60,
    };
    const settings: Settings = {
      ...DEFAULT_SETTINGS, teammate: { ...DEFAULT_TEAMMATE, profiles: [profile], defaultProfile: 'fake' },
    };
    const bubbles: BubbleState[] = [];
    const pings: string[] = [];
    const appends: string[] = [];
    let captures = 0;
    const runner = new AgentRunner({
      spawn, platform, killTree: killProcessTree(platform), writeFile: (p, t) => writeFile(p, t),
    });
    const deps: AskDeps = {
      settings: () => settings,
      enabled: () => true,
      lang: () => 'en',
      secrets: { available: () => true, key: () => null, instructions: () => '' },
      context: {
        foreground: async () => ({ app: 'notepad.exe', title: 'notes.txt', window: '1', pid: 4242 }),
        capture: async (req) => {
          captures += 1;
          await mkdir(req.dir, { recursive: true });
          const overviewPath = path.join(req.dir, `overview-c${captures}.jpg`);
          await writeFile(overviewPath, JPEG);
          const zooms = await Promise.all(req.spots.map(async (p, i) => {
            const zoom = path.join(req.dir, `zoom-c${captures}-${i + 1}.jpg`);
            await writeFile(zoom, JPEG);
            return { path: zoom, rect: req.crops?.[i] ?? zoomRect(req.display, p) };
          }));
          return { overviewPath, overview: { w: 1600, h: 1000 }, zooms };
        },
        read: async (req) => ({
          status: { marks: 'off', text: 'off', file: 'off', boxes: 'off', fields: 'off' },
          fields: null, marks: null, text: null, file: null, boxes: req.boxes ? req.spots.map(() => []) : null,
        }),
      },
      ownPid: 1000,
      readers: {
        readFile: async () => '',
        readDocument: async () => {
          throw new Error('no file');
        },
        fetchWebPdf: async () => {
          throw new Error('no network in tests');
        },
        readPdfBuffer: async () => {
          throw new Error('no PDFs in tests');
        },
      },
      adapter: () => {
        throw new Error('no provider in this test');
      },
      overlay: {
        spawnMate: (p) => void pings.push(p.id),
        spawnMateEmote: () => undefined,
        mateSaid: () => undefined,
        clearMate: () => undefined,
        fadeMate: () => undefined,
        setMateTicket: () => undefined,
        setCaptureExcluded: () => undefined,
        displayAt: () => ({ id: 1, rect: DISPLAY }),
        toLocal: (p) => ({ displayId: 1, x: p.x / 2, y: p.y / 2 }),
        toDip: (p) => ({ x: p.x / 2, y: p.y / 2 }),
        primaryDip: () => ({ x: 960, y: 540 }),
      },
      windows: {
        showBubble: (_at, s) => void bubbles.push(s),
        updateBubble: (s) => void bubbles.push(s),
        hideBubble: () => undefined,
        hideNow: () => undefined,
        showCard: () => undefined,
        updateCard: () => undefined,
        hideCard: () => undefined,
        placeOf: () => null,
        setCaptureExcluded: () => undefined,
      },
      history: {
        current: () => null,
        append: async (_id, entry, meta) => {
          appends.push(entry.line);
          return { id: 't1', ...meta, started: 0, lastActivity: 0, entries: [entry] };
        },
        amend: async () => undefined,
      },
      tempDir: () => path.join(dir, 'asks'),
      thumbnail: () => '',
      now: Date.now,
      usage: () => undefined,
      agents: {
        runner,
        bridge: {
          command: (ask) => bridgeCommand({ execPath: process.execPath, bridgeJs, pipe, dataDir: dir, ask }),
        },
        env: async () => ({ ...process.env, FAKE_AGENT_SAY: 'Hello through the bridge.' }),
        home: () => dir,
        platform,
      },
    };
    const controller = new AskController(deps);
    const server = new BridgeServer({
      path: pipe, tokenFile: path.join(dir, 'mcp-token'), handler: bridgeHandler(controller),
      random: randomBytes, writeToken: (file, token) => writeFile(file, token, { mode: 0o600 }),
    });
    await server.start();
    try {
      controller.ask([{ intent: 'danger', phys: { x: 1000, y: 800 }, displayId: 1 }]);
      await until(() => !controller.running, 'the ask to end');
      expect(bubbles.map((b) => b.line)).toEqual(['Hello through the bridge.']);
      expect(pings).toEqual(['omw', 'danger']);
      expect(appends).toEqual(['Hello through the bridge.']);
    } finally {
      runner.killAll();
      await server.stop();
    }
  }, 30_000);
});

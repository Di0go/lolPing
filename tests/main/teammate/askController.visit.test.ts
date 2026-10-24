import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AskController, bridgeHandler, type AskDeps } from '../../../src/main/teammate/askController';
import type { PingTag } from '../../../src/shared/ipc';
import { DEFAULT_SETTINGS, type Settings } from '../../../src/shared/settings';
import { EMOTE_CATALOG } from '../../../src/shared/emoteCatalog';
import { DEFAULT_TEAMMATE, type AgentProfile, type TeammateSettings } from '../../../src/shared/teammate/settings';
import type { BubbleState, CardState } from '../../../src/shared/teammateIpc';

const DISPLAY = { x: 0, y: 0, w: 3200, h: 2000 };
const CURSOR = { x: 1000, y: 800 };
const OFF_TEXT = 'The user hasn\'t let agents ping them. They can turn on Let agents ping me in lolPing\'s '
  + 'Teammate settings.';

const claude = (over: Partial<AgentProfile> = {}): AgentProfile => ({
  id: 'cc', kind: 'agent', name: 'My Claude', tagColor: 1, tagColorCustom: null, preset: 'claude', command: 'claude',
  customArgs: [], folder: { kind: 'fixed', path: 'C:\\code' }, timeoutS: 300, ...over,
});

interface Options {
  teammate?: Partial<TeammateSettings>;
  /** The foreground app never answers, so an ask started in the test keeps running. */
  holdAsk?: boolean;
}

function harness(opts: Options = {}) {
  const pings: Array<{ id: string; x: number; y: number; tag?: PingTag; silent?: boolean }> = [];
  const emotes: Array<{ slug: string; tag?: PingTag }> = [];
  const bubbles: BubbleState[] = [];
  const cards: CardState[] = [];
  const bubbleAt: Array<{ x: number; y: number }> = [];
  const cardAt: Array<{ x: number; y: number }> = [];
  const fades: number[] = [];
  const appends: unknown[] = [];
  let time = 1_000_000;
  const actions = Object.assign(new EventEmitter(), {
    take: () => undefined, put: async () => undefined, cancel: () => undefined, described: () => [] as string[],
    askAgent: async () => 'deny' as const,
  });
  const settings: Settings = {
    ...DEFAULT_SETTINGS,
    teammate: { ...DEFAULT_TEAMMATE, agentsCanPing: true, ...opts.teammate },
  };
  const deps: AskDeps = {
    settings: () => settings,
    lang: () => 'en',
    secrets: { available: () => true, key: () => null, instructions: () => '' },
    context: {
      foreground: () => (opts.holdAsk
        ? new Promise(() => undefined)
        : Promise.resolve({ app: '', title: '', window: '' })),
      capture: async () => {
        throw new Error('a visitor never captures');
      },
      read: async () => {
        throw new Error('a visitor never reads');
      },
    },
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
      throw new Error('a visitor never makes a provider adapter');
    },
    overlay: {
      spawnMate: (p) => void pings.push(p),
      spawnMateEmote: (p) => void emotes.push(p),
      mateSaid: () => undefined,
      clearMate: () => undefined,
      fadeMate: () => void fades.push(time),
      setMateTicket: () => undefined,
      setCaptureExcluded: () => undefined,
      displayAt: () => ({ id: 1, rect: DISPLAY }),
      toLocal: (p) => ({ displayId: 1, x: p.x / 2, y: p.y / 2 }),
      toDip: (p) => ({ x: p.x / 2, y: p.y / 2 }),
      primaryDip: () => ({ x: 960, y: 540 }),
    },
    windows: {
      showBubble: (at, s) => {
        bubbleAt.push(at);
        bubbles.push(s);
      },
      updateBubble: (s) => void bubbles.push(s),
      hideBubble: () => undefined,
      hideNow: () => undefined,
      showCard: (at, s) => {
        cardAt.push(at);
        cards.push(s);
      },
      updateCard: (s) => void cards.push(s),
      hideCard: () => undefined,
      placeOf: () => null,
      setCaptureExcluded: () => undefined,
    },
    history: {
      current: () => null,
      append: async (threadId, entry, meta) => {
        appends.push(entry);
        return { id: 't1', ...meta, started: 0, lastActivity: 0, entries: [entry] };
      },
      amend: async () => undefined,
    },
    tempDir: () => 'tmp',
    thumbnail: () => 'thumb',
    now: () => time,
    usage: () => undefined,
    files: {
      read: async (p) => Buffer.from(p),
      write: async () => undefined,
      makeDir: async () => undefined,
      removeDir: async () => undefined,
    },
    actions,
    cursor: () => CURSOR,
  };
  const ctl = new AskController(deps);
  return {
    ctl, actions, settings, pings, emotes, bubbles, cards, bubbleAt, cardAt, fades, appends,
    advance: (ms: number) => {
      time += ms;
      return vi.advanceTimersByTimeAsync(ms);
    },
  };
}

const text = (r: { content: unknown[] }): string => (r.content[0] as { text?: string } | undefined)?.text ?? '';
const ping = { type: 'danger' };

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('AskController visitors', () => {
  it('refuses unprompted calls while the switch is off', async () => {
    const h = harness({ teammate: { agentsCanPing: false } });
    const r = await h.ctl.visitorCall({ name: 'claude-code' }, 'ping', ping);
    expect(r.isError).toBe(true);
    expect(text(r)).toBe(OFF_TEXT);
    await h.ctl.visitorCall({ name: 'claude-code' }, 'say', { text: 'hi' });
    expect(h.pings).toEqual([]);
    expect(h.bubbles).toEqual([]);
  });

  it('reads the switch at each call', async () => {
    const h = harness({ teammate: { agentsCanPing: false } });
    expect((await h.ctl.visitorCall({ name: 'a' }, 'ping', ping)).isError).toBe(true);
    h.settings.teammate.agentsCanPing = true;
    expect((await h.ctl.visitorCall({ name: 'a' }, 'ping', ping)).isError).toBe(false);
    h.settings.teammate.agentsCanPing = false;
    expect((await h.ctl.visitorCall({ name: 'a' }, 'ping', ping)).isError).toBe(true);
  });

  it('draws an unprompted ping near the cursor with the agent\'s name', async () => {
    const h = harness({ teammate: { profiles: [claude()] } });
    const r = await h.ctl.visitorCall({ name: 'claude-code' }, 'ping', { ...ping, label: 'look', x: 5, y: 6 });
    expect(r).toEqual({ content: [{ text: 'Done.' }], isError: false });
    // 40 px up and right of the cursor, in physical px, then mapped to the overlay.
    expect(h.pings).toHaveLength(1);
    expect(h.pings[0]).toMatchObject({
      id: 'danger', label: 'look', x: (CURSOR.x + 40) / 2, y: (CURSOR.y - 40) / 2,
      tag: { name: 'My Claude', color: 1, rgb: null },
    });
  });

  it('names an agent without a profile after its client, cut to 12 characters, in the tag colour', async () => {
    const h = harness({ teammate: { tagColor: 5 } });
    await h.ctl.visitorCall({ name: 'my-notes-assistant' }, 'ping', ping);
    expect(h.pings[0].tag).toEqual({ name: 'my-notes-ass', color: 5, rgb: null });
  });

  it('names a known agent without a profile after its preset', async () => {
    const h = harness();
    await h.ctl.visitorCall({ name: 'gemini-cli-mcp-client' }, 'ping', ping);
    expect(h.pings[0].tag?.name).toBe('Gemini CLI');
  });

  it('shows a say as the bubble there and an answer as the card, with the agent\'s tag', async () => {
    const h = harness({ teammate: { profiles: [claude()] } });
    await h.ctl.visitorCall({ name: 'claude-code' }, 'say', { text: 'Build is green.' });
    expect(h.bubbles.at(-1)).toMatchObject({ line: 'Build is green.', tag: { name: 'My Claude', color: 1 } });
    expect(h.bubbleAt[0]).toEqual({ x: (CURSOR.x + 40) / 2 + 24, y: (CURSOR.y - 40) / 2 - 24 });

    await h.ctl.visitorCall({ name: 'claude-code' }, 'answer', { markdown: '## Done\n\nAll tests pass.' });
    expect(h.cards).toHaveLength(1);
    expect(h.cards[0].tag.name).toBe('My Claude');
    expect(h.cards[0].entries).toEqual([
      { kind: 'answer', label: 'My Claude', line: '', markdown: '## Done\n\nAll tests pass.' },
    ]);
  });

  it('keeps an unprompted answer out of history and out of the current thread', async () => {
    const h = harness();
    await h.ctl.visitorCall({ name: 'x' }, 'say', { text: 'hi' });
    await h.ctl.visitorCall({ name: 'x' }, 'answer', { markdown: 'long' });
    expect(h.appends).toEqual([]);
    expect(h.ctl.currentThread()).toBeNull();
  });

  it('draws an emote at the cursor when emotes are on and refuses it when they are off', async () => {
    const h = harness();
    const slug = EMOTE_CATALOG[0].slug;
    expect((await h.ctl.visitorCall({ name: 'x' }, 'emote', { slug })).isError).toBe(false);
    expect(h.emotes).toMatchObject([{ slug }]);

    const off = harness({ teammate: { emotes: false } });
    const r = await off.ctl.visitorCall({ name: 'x' }, 'emote', { slug });
    expect(r.isError).toBe(true);
    expect(off.emotes).toEqual([]);
    expect(off.ctl.visitorTools().map((d) => d.name)).toEqual(['say', 'ping', 'answer']);
  });

  it('offers say, ping, emote and answer, with no position on a ping', () => {
    const h = harness();
    const tools = h.ctl.visitorTools();
    expect(tools.map((d) => d.name)).toEqual(['say', 'ping', 'emote', 'answer']);
    expect(Object.keys(tools[1].parameters.properties as object)).not.toContain('x');
  });

  it('refuses a tool that only an ask can use, and a call that is not valid', async () => {
    const h = harness();
    expect((await h.ctl.visitorCall({ name: 'x' }, 'look', { x: 1, y: 1, w: 5, h: 5 })).isError).toBe(true);
    expect((await h.ctl.visitorCall({ name: 'x' }, 'paste', { text: 'a', mode: 'insert' })).isError).toBe(true);
    expect((await h.ctl.visitorCall({ name: 'x' }, 'ping', { type: 'nope' })).isError).toBe(true);
    expect(h.pings).toEqual([]);
  });

  it('refuses while an ask is running', async () => {
    const h = harness({ holdAsk: true });
    h.ctl.ask({ intent: 'danger', phys: CURSOR, displayId: 1 });
    expect(h.ctl.running).toBe(true);
    const r = await h.ctl.visitorCall({ name: 'x' }, 'ping', ping);
    expect(r.isError).toBe(true);
    expect(text(r)).toBe('lolPing is busy; try again in a moment.');
    expect(h.pings).toEqual([]);
  });

  it('refuses while a consent card or form preview waits for the user', async () => {
    const h = harness();
    h.actions.emit('asking', true);
    expect(text(await h.ctl.visitorCall({ name: 'x' }, 'ping', ping))).toBe('lolPing is busy; try again in a moment.');
    h.actions.emit('asking', false);
    expect((await h.ctl.visitorCall({ name: 'x' }, 'ping', ping)).isError).toBe(false);
  });

  it('tells a refused agent why before it counts the call against the rate', async () => {
    const h = harness({ teammate: { agentsCanPing: false } });
    for (let i = 0; i < 20; i += 1) await h.ctl.visitorCall({ name: 'x' }, 'ping', ping);
    h.settings.teammate.agentsCanPing = true;
    expect((await h.ctl.visitorCall({ name: 'x' }, 'ping', ping)).isError).toBe(false);
  });

  it('rate-limits a client that pings too often', async () => {
    const h = harness();
    for (let i = 0; i < 5; i += 1) {
      expect((await h.ctl.visitorCall({ name: 'busy' }, 'ping', ping)).isError).toBe(false);
    }
    const sixth = await h.ctl.visitorCall({ name: 'busy' }, 'ping', ping);
    expect(sixth.isError).toBe(true);
    expect(text(sixth)).toBe('Too many pings.');
    // Another client has its own allowance, and the first one has its again a moment later.
    expect((await h.ctl.visitorCall({ name: 'quiet' }, 'ping', ping)).isError).toBe(false);
    await h.advance(1000);
    expect((await h.ctl.visitorCall({ name: 'busy' }, 'ping', ping)).isError).toBe(false);
  });

  it('rate-limits all clients together', async () => {
    const h = harness();
    let allowed = 0;
    for (let i = 0; i < 20; i += 1) {
      const r = await h.ctl.visitorCall({ name: `agent-${i}` }, 'ping', ping);
      if (!r.isError) allowed += 1;
      else expect(text(r)).toBe('Too many pings.');
    }
    expect(allowed).toBe(10);
  });

  it('fades an unprompted ping like an answered ask does, after 15 seconds', async () => {
    const h = harness();
    await h.ctl.visitorCall({ name: 'x' }, 'ping', ping);
    await h.advance(14_000);
    expect(h.fades).toEqual([]);
    await h.advance(1_500);
    expect(h.fades).toHaveLength(1);
  });

  it('serves unprompted calls through the bridge handler, and an ask\'s through its token', async () => {
    const h = harness();
    const handler = bridgeHandler(h.ctl);
    const session = { ask: null, client: { name: 'claude-code', version: '1' } };
    const signal = new AbortController().signal;
    expect(handler.list(session).map((d) => d.name)).toEqual(['say', 'ping', 'emote', 'answer']);
    expect((await handler.call(session, 'ping', ping, signal)).isError).toBe(false);
    expect(h.pings).toHaveLength(1);
    expect(handler.list({ ...session, ask: 'ask-1.00000000000000000000000000000000' })).toEqual([]);
  });
});

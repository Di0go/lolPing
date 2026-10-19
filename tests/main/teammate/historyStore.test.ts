import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HistoryStore } from '../../../src/main/teammate/historyStore';
import type { Crypto } from '../../../src/main/teammate/secrets';
import type { PingId } from '../../../src/shared/pings';

const MARK = Buffer.from('FAKE:');
const fakeCrypto = (available = true): Crypto => ({
  isEncryptionAvailable: () => available,
  encryptString: (s) => Buffer.concat([MARK, Buffer.from(Buffer.from(s, 'utf8').map((b) => b ^ 0x5a))]),
  decryptString: (b) => {
    if (!b.subarray(0, MARK.length).equals(MARK)) throw new Error('not encrypted by this keychain');
    return Buffer.from(b.subarray(MARK.length).map((x) => x ^ 0x5a)).toString('utf8');
  },
});
const root = () => mkdtempSync(join(tmpdir(), 'lolping-history-'));
const meta = { title: 'Baron pit', app: 'League', windowTitle: 'League of Legends', profile: 'p1' };
const entry = (line: string, words: string | null = null) => ({
  at: 1,
  intent: 'danger' as PingId,
  words,
  line,
  markdown: line,
  thumb: 'AAAA',
});
const DAY = 86_400_000;

describe('HistoryStore', () => {
  it('appends and reads a thread back', async () => {
    const store = new HistoryStore(join(root(), 'history'), fakeCrypto(), () => 1000);
    const first = await store.append(null, entry('go left'), meta);
    const second = await store.append(first.id, entry('now right'), meta);
    expect(second.id).toBe(first.id);
    const read = await store.get(first.id);
    expect(read?.entries.map((e) => e.line)).toEqual(['go left', 'now right']);
    expect(read?.title).toBe('Baron pit');
    expect(store.current()?.id).toBe(first.id);
    expect((await store.list()).map((t) => t.id)).toEqual([first.id]);
    await store.delete(first.id);
    expect(await store.get(first.id)).toBeNull();
    expect(store.current()).toBeNull();
  });

  it('stores nothing in plain text', async () => {
    const d = join(root(), 'history');
    const store = new HistoryStore(d, fakeCrypto(), () => 1000);
    await store.append(null, entry('secret plan', 'my private words'), meta);
    const files = readdirSync(d);
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const bytes = readFileSync(join(d, f)).toString('latin1');
      expect(bytes).not.toContain('secret plan');
      expect(bytes).not.toContain('private words');
      expect(bytes).not.toContain('Baron');
    }
  });

  it('skips a thread file it cannot decrypt', async () => {
    const d = join(root(), 'history');
    const store = new HistoryStore(d, fakeCrypto(), () => 1000);
    const good = await store.append(null, entry('fine'), meta);
    writeFileSync(join(d, 'broken.thread'), Buffer.from('garbage'));
    expect((await store.list()).map((t) => t.id)).toEqual([good.id]);
    expect(await store.get('broken')).toBeNull();
  });

  it('writes nothing while paused', async () => {
    const d = join(root(), 'history');
    let on = false;
    const store = new HistoryStore(d, fakeCrypto(), () => 1000, { enabled: () => on });
    await store.append(null, entry('hidden'), meta);
    expect(await store.list()).toEqual([]);
    expect(store.current()).toBeNull();
    on = true;
    await store.append(null, entry('kept'), meta);
    expect(await store.list()).toHaveLength(1);
  });

  it('writes nothing and does not throw when encryption is unavailable', async () => {
    const r = root();
    const store = new HistoryStore(join(r, 'history'), fakeCrypto(false), () => 1000);
    expect(store.available()).toBe(false);
    await store.append(null, entry('x'), meta);
    expect(await store.list()).toEqual([]);
    expect(readdirSync(r)).toEqual([]);
  });

  it('searches titles and lines', async () => {
    const store = new HistoryStore(join(root(), 'history'), fakeCrypto(), () => 1000);
    await store.append(null, entry('watch the river', 'where is jungle'), meta);
    await store.append(null, entry('farm top'), { ...meta, title: 'Top lane' });
    expect((await store.list('baron')).map((t) => t.title)).toEqual(['Baron pit']);
    expect((await store.list('TOP')).map((t) => t.title)).toEqual(['Top lane']);
    expect((await store.list('river')).map((t) => t.title)).toEqual(['Baron pit']);
    expect((await store.list('jungle')).map((t) => t.title)).toEqual(['Baron pit']);
    expect(await store.list('nothing')).toEqual([]);
  });

  it('prunes on start and after each append', async () => {
    const d = join(root(), 'history');
    let now = 0;
    const rule = () => ({ keepDays: 30, maxThreads: 2 });
    const store = new HistoryStore(d, fakeCrypto(), () => now, { rule });
    const old = await store.append(null, entry('old'), meta);
    now = 40 * DAY;
    await store.append(null, entry('new'), meta);
    expect(await store.get(old.id)).toBeNull();
    now = 41 * DAY;
    await store.append(null, entry('newer'), meta);
    await store.append(null, entry('newest'), meta);
    expect(await store.list()).toHaveLength(2);
    now = 100 * DAY;
    const restarted = new HistoryStore(d, fakeCrypto(), () => now, { rule });
    await restarted.prune(rule());
    expect(await restarted.list()).toEqual([]);
  });
});

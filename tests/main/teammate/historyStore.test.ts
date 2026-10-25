import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  spots: 1,
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

  it('keeps both entries when two appends to one thread overlap', async () => {
    const store = new HistoryStore(join(root(), 'history'), fakeCrypto(), () => 1000);
    const first = await store.append(null, entry('one'), meta);
    await Promise.all([store.append(first.id, entry('two'), meta), store.append(first.id, entry('three'), meta)]);
    expect((await store.get(first.id))?.entries.map((e) => e.line)).toEqual(['one', 'two', 'three']);
  });

  it('lists and prunes from its index without re-reading thread files', async () => {
    const d = join(root(), 'history');
    let decrypts = 0;
    const crypto = fakeCrypto();
    const counting: Crypto = { ...crypto, decryptString: (b) => (decrypts++, crypto.decryptString(b)) };
    const seed = new HistoryStore(d, crypto, () => 1000);
    const a = await seed.append(null, entry('alpha'), meta);
    const store = new HistoryStore(d, counting, () => 1000);
    expect((await store.list()).map((t) => t.id)).toEqual([a.id]);
    const afterStart = decrypts;
    rmSync(join(d, a.id + '.thread'));
    expect((await store.list('alpha')).map((t) => t.id)).toEqual([a.id]);
    await store.prune({ keepDays: 30, maxThreads: 5 });
    expect(decrypts).toBe(afterStart);
  });

  it('clears every thread', async () => {
    const d = join(root(), 'history');
    const store = new HistoryStore(d, fakeCrypto(), () => 1000);
    await store.append(null, entry('a'), meta);
    await store.append(null, entry('b'), meta);
    await store.clear();
    expect(await store.list()).toEqual([]);
    expect(readdirSync(d)).toEqual([]);
    expect(store.current()).toBeNull();
  });

  it('keeps the thread it just appended even when the rule would drop it', async () => {
    const store = new HistoryStore(join(root(), 'history'), fakeCrypto(), () => 1000, {
      rule: () => ({ keepDays: null, maxThreads: 0 }),
    });
    const t = await store.append(null, entry('mine'), meta);
    expect((await store.list()).map((x) => x.id)).toEqual([t.id]);
  });

  it('rejects a stored entry with an unknown intent', async () => {
    const d = join(root(), 'history');
    const crypto = fakeCrypto();
    const store = new HistoryStore(d, crypto, () => 1000);
    const t = await store.append(null, entry('ok'), meta);
    const bad = { ...t, entries: [{ ...t.entries[0], intent: 'nope' }] };
    writeFileSync(join(d, t.id + '.thread'), crypto.encryptString(JSON.stringify(bad)));
    expect(await new HistoryStore(d, crypto, () => 1000).list()).toEqual([]);
  });

  it('has the record ready from current() once setCurrent resolves', async () => {
    const d = join(root(), 'history');
    const seed = new HistoryStore(d, fakeCrypto(), () => 1000);
    const t = await seed.append(null, entry('hello'), meta);
    const store = new HistoryStore(d, fakeCrypto(), () => 1000);
    expect(store.current()).toBeNull();
    await store.setCurrent(t.id);
    expect(store.current()?.entries[0].line).toBe('hello');
    await store.setCurrent(null);
    expect(store.current()).toBeNull();
  });

  it('adds what was done to an entry after it was written, and reads old entries without it', async () => {
    const d = join(root(), 'history');
    const store = new HistoryStore(d, fakeCrypto(), () => 1000);
    const t = await store.append(null, { ...entry('first'), at: 5 }, meta);
    await store.append(t.id, { ...entry('second'), at: 7, done: ['Copied 1 line'] }, meta);
    await store.amend(t.id, 5, ['Pasted 2 lines into Chrome']);
    await store.amend('missing', 5, ['Opened a link']);
    const read = await new HistoryStore(d, fakeCrypto(), () => 1000).get(t.id);
    expect(read?.entries.map((e) => e.done)).toEqual([['Pasted 2 lines into Chrome'], ['Copied 1 line']]);
    expect(store.current()?.entries[0].done).toEqual(['Pasted 2 lines into Chrome']);
    const fresh = new HistoryStore(join(root(), 'history'), fakeCrypto(), () => 1000);
    const old = await fresh.append(null, entry('x'), meta);
    expect('done' in old.entries[0]).toBe(false);
  });

  it('keeps each ask\'s spot count, and reads an entry written before spots as one spot', async () => {
    const d = join(root(), 'history');
    const crypto = fakeCrypto();
    const store = new HistoryStore(d, crypto, () => 1000);
    const t = await store.append(null, { ...entry('three spots'), spots: 3 }, meta);
    expect((await new HistoryStore(d, crypto, () => 1000).get(t.id))?.entries[0].spots).toBe(3);
    const { spots: _dropped, ...old } = t.entries[0];
    writeFileSync(join(d, t.id + '.thread'), crypto.encryptString(JSON.stringify({ ...t, entries: [old] })));
    expect((await new HistoryStore(d, crypto, () => 1000).get(t.id))?.entries[0].spots).toBe(1);
  });

  it('rejects a stored entry whose done list is not text', async () => {
    const d = join(root(), 'history');
    const crypto = fakeCrypto();
    const store = new HistoryStore(d, crypto, () => 1000);
    const t = await store.append(null, entry('ok'), meta);
    const bad = { ...t, entries: [{ ...t.entries[0], done: [3] }] };
    writeFileSync(join(d, t.id + '.thread'), crypto.encryptString(JSON.stringify(bad)));
    expect(await new HistoryStore(d, crypto, () => 1000).list()).toEqual([]);
  });

  it('keeps the agent session with the thread, and a later answer\'s session replaces it', async () => {
    const d = join(root(), 'history');
    const store = new HistoryStore(d, fakeCrypto(), () => 1000);
    const agent = { profileId: 'cc', session: 'sess-1', cwd: 'C:\\code\\lolPing' };
    const t = await store.append(null, entry('one'), { ...meta, agent });
    await store.append(t.id, entry('two'), meta);
    expect((await new HistoryStore(d, fakeCrypto(), () => 1000).get(t.id))?.agent).toEqual(agent);
    const next = { ...agent, session: 'sess-2', cwd: 'D:\\other' };
    await store.append(t.id, entry('three'), { ...meta, agent: next });
    expect((await new HistoryStore(d, fakeCrypto(), () => 1000).get(t.id))?.agent).toEqual(next);
  });

  it('lists which agent profile answered a thread, and nothing for a thread without one', async () => {
    const store = new HistoryStore(join(root(), 'history'), fakeCrypto(), () => 1000);
    const agent = { profileId: 'cc', session: 'sess-1', cwd: 'C:\\code\\lolPing' };
    const withAgent = await store.append(null, entry('one'), { ...meta, agent });
    const without = await store.append(null, entry('two'), meta);
    const list = await store.list();
    expect(list.find((t) => t.id === withAgent.id)?.agent).toBe('cc');
    const plain = list.find((t) => t.id === without.id);
    expect(plain && 'agent' in plain).toBe(false);
  });

  it('drops a stored agent session that is not valid, and keeps the thread', async () => {
    const d = join(root(), 'history');
    const crypto = fakeCrypto();
    const store = new HistoryStore(d, crypto, () => 1000);
    const t = await store.append(null, entry('ok'), meta);
    const bad = { ...t, agent: { profileId: 'cc', session: 'a b; rm -rf', cwd: 'C:\\x' } };
    writeFileSync(join(d, t.id + '.thread'), crypto.encryptString(JSON.stringify(bad)));
    const read = await new HistoryStore(d, crypto, () => 1000).get(t.id);
    expect(read?.entries.map((e) => e.line)).toEqual(['ok']);
    expect(read && 'agent' in read).toBe(false);
  });
});

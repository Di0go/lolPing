import { spawn, type SpawnOptions } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ContextClient, ContextError } from '../../../src/main/teammate/contextClient';

const fake = resolve(__dirname, '../fixtures/fake-context-helper.mjs');
const clients: ContextClient[] = [];
const dirs: string[] = [];

/** A client whose n-th helper start runs the fake in `modes[n]` (the last mode repeats). */
function client(modes: string[], timeoutMs?: number): { c: ContextClient; starts: () => number } {
  let starts = 0;
  const run = (_command: string, _args: readonly string[], options: SpawnOptions) => {
    const mode = modes[Math.min(starts, modes.length - 1)];
    starts += 1;
    return spawn(process.execPath, [fake, mode], options);
  };
  const c = new ContextClient({ command: 'context-helper', spawn: run, timeoutMs });
  clients.push(c);
  return { c, starts: () => starts };
}

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'lp-context-'));
  dirs.push(d);
  return d;
}

const signal = (): AbortSignal => new AbortController().signal;
const display = { x: 0, y: 0, w: 1920, h: 1080 };

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(clients.splice(0).map((c) => c.stop()));
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('ContextClient', () => {
  it('resolves a capture with the files the helper wrote', async () => {
    const { c } = client(['ok']);
    const dir = tempDir();
    const shot = await c.capture({ display, spots: [{ x: 100, y: 200 }, { x: 1500.4, y: 900 }], dir }, signal());
    expect(shot.overview).toEqual({ w: 1600, h: 900 });
    expect(existsSync(shot.overviewPath)).toBe(true);
    expect(shot.zooms.map((z) => z.rect)).toEqual([
      { x: -400, y: -175, w: 1000, h: 750 },
      { x: 1000, y: 525, w: 1000, h: 750 },
    ]);
    for (const z of shot.zooms) expect(existsSync(z.path)).toBe(true);
    const sent: unknown = JSON.parse(readFileSync(join(dir, 'command.json'), 'utf8'));
    expect(sent).toMatchObject({
      type: 'capture', display: '0,0,1920,1080', spots: '100,200;1500,900', overview: 1600, zoom: '1000,750', quality: 80, dir,
    });
  });

  it('restarts the helper when it does not answer in 3 s', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { c, starts } = client(['silent', 'ok']);
    const outcome = c.capture({ display, spots: [], dir: tempDir() }, signal()).then(() => 'resolved', (e: unknown) => e);
    await vi.advanceTimersByTimeAsync(2999);
    expect(starts()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    const err = await outcome;
    expect(err).toBeInstanceOf(ContextError);
    expect((err as ContextError).code).toBe('timeout');
    expect(starts()).toBe(2);
    await expect(c.foreground(signal())).resolves.toEqual({ app: 'notepad', title: 'notes.txt - Notepad', window: '263544', pid: 4242 });
  });

  it('rejects when aborted and ignores the late reply', async () => {
    const { c, starts } = client(['ok']);
    const ac = new AbortController();
    const shot = c.capture({ display, spots: [{ x: 10, y: 10 }], dir: tempDir() }, ac.signal);
    ac.abort();
    await expect(shot).rejects.toMatchObject({ code: 'aborted' });
    // The helper still answers the capture before this; that late line must not settle anything else.
    await expect(c.foreground(signal())).resolves.toEqual({ app: 'notepad', title: 'notes.txt - Notepad', window: '263544', pid: 4242 });
    expect(starts()).toBe(1);
  });

  it('rejects at once when the signal is already aborted', async () => {
    const { c, starts } = client(['ok']);
    const ac = new AbortController();
    ac.abort();
    await expect(c.foreground(ac.signal)).rejects.toMatchObject({ code: 'aborted' });
    expect(starts()).toBe(0);
  });

  it('reads the foreground app and title', async () => {
    const { c } = client(['ok']);
    await expect(c.foreground(signal())).resolves.toEqual({ app: 'notepad', title: 'notes.txt - Notepad', window: '263544', pid: 4242 });
  });

  it('reads the window in front', async () => {
    const { c } = client(['ok']);
    await expect(c.front(signal())).resolves.toEqual({
      window: '263544', title: 'notes.txt - Notepad', box: { x: -1920, y: 40, w: 900, h: 700 }, pid: 4242,
    });
  });

  it('is busy while a request waits', async () => {
    const { c } = client(['lagged']);
    expect(c.busy).toBe(false);
    const waiting = c.foreground(signal()); // the lagged helper answers it after 300 ms
    expect(c.busy).toBe(true);
    await waiting;
    expect(c.busy).toBe(false);
  });

  it('stays busy until the helper answers an aborted request', async () => {
    const { c } = client(['lagged']);
    const ac = new AbortController();
    const waiting = c.foreground(ac.signal); // the lagged helper answers it after 300 ms
    ac.abort();
    await expect(waiting).rejects.toMatchObject({ code: 'aborted' });
    // The helper answers in order: a poll sent now would still wait behind the aborted request.
    expect(c.busy).toBe(true);
    await vi.waitFor(() => expect(c.busy).toBe(false), { timeout: 3000, interval: 20 });
  });

  it('is not busy once the helper that had a request waiting is gone', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { c } = client(['silent', 'ok']);
    const ac = new AbortController();
    const waiting = c.foreground(ac.signal).catch((e: unknown) => e);
    ac.abort();
    await waiting;
    expect(c.busy).toBe(true);
    // A later request times out and restarts the helper: the old one's unanswered requests are gone with it.
    const timedOut = c.foreground(signal()).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(3000);
    expect(await timedOut).toMatchObject({ code: 'timeout' });
    expect(c.busy).toBe(false);
  });

  it('passes on the helper\'s error code', async () => {
    const { c } = client(['denied']);
    await expect(c.capture({ display, spots: [], dir: tempDir() }, signal())).rejects.toMatchObject({ code: 'permission' });
  });

  it('reads every layer it asks for in one request', async () => {
    const { c } = client(['ok']);
    const dir = tempDir();
    const req = {
      spots: [{ x: 100.4, y: 200 }], radius: 600, marks: true, text: true, file: true, boxes: true, fields: true, dir,
    };
    const got = await c.read(req, signal());
    expect(got.status).toEqual({ marks: 'ok', text: 'ok', file: 'ok', boxes: 'ok', fields: 'ok' });
    expect(got.fields?.count).toBe(1);
    expect(readFileSync(got.fields?.path ?? '', 'utf8')).toContain('"label":"Name"');
    expect(got.boxes).toEqual([[{ x: 90, y: 190, w: 40, h: 20 }, { x: 0, y: 0, w: 1400, h: 1000 }]]);
    expect(got.marks?.count).toBe(1);
    expect(readFileSync(got.marks?.path ?? '', 'utf8')).toBe('button\t900\t700\t200\t60\tSave\n');
    expect(got.text).toEqual({ selection: 'chosen', spotTexts: ['under the spot'], focus: null, address: '' });
    expect(got.file).toEqual({ path: 'C:/docs/a.txt', address: '', how: 'title' });
    const sent: unknown = JSON.parse(readFileSync(join(dir, 'read-command.json'), 'utf8'));
    expect(sent).toMatchObject({
      type: 'read', spots: '100,200', radius: 600, marks: true, text: true, file: true, boxes: true, fields: true,
    });
  });

  it('leaves out the layers it does not ask for', async () => {
    const { c } = client(['ok']);
    const req = {
      spots: [], radius: 600, marks: false, text: true, file: false, boxes: false, fields: false, dir: tempDir(),
    };
    const got = await c.read(req, signal());
    expect(got.status).toEqual({ marks: 'off', text: 'ok', file: 'off', boxes: 'off', fields: 'off' });
    expect(got.fields).toBeNull();
    expect(got.boxes).toBeNull();
    expect(got.marks).toBeNull();
    expect(got.file).toBeNull();
  });

  it('keeps what a helper read on its way out, and starts a new helper after it', async () => {
    const { c, starts } = client(['slow', 'ok']);
    const req = {
      spots: [{ x: 100, y: 200 }], radius: 600, marks: true, text: true, file: true, boxes: false, fields: false,
      dir: tempDir(),
    };
    const got = await c.read(req, signal());
    expect(got.status).toEqual({ marks: 'ok', text: 'ok', file: 'slow', boxes: 'off', fields: 'off' });
    expect(got.marks?.count).toBe(1);
    expect(got.file).toBeNull();
    // The old helper is on its way out and reads nothing more: this request must go to a fresh one.
    await expect(c.foreground(signal())).resolves.toEqual({ app: 'notepad', title: 'notes.txt - Notepad', window: '263544', pid: 4242 });
    expect(starts()).toBe(2);
  });

  it('rejects instead of throwing when the helper cannot start', async () => {
    const c = new ContextClient({ command: join(tmpdir(), 'definitely-missing-context-helper.exe') });
    clients.push(c);
    await expect(c.foreground(signal())).rejects.toMatchObject({ code: 'exited' });
  });

  it('pastes and sets a field, passing on the helper\'s result', async () => {
    const { c } = client(['ok']);
    const paste = { window: '263544', text: 'hello', click: { x: 10, y: 20 }, mode: 'insert' as const, asked: '' };
    await expect(c.paste(paste, signal())).resolves.toEqual({ result: 'ok', restored: true });
    await expect(c.paste({ ...paste, text: 'clipboard held' }, signal()))
      .resolves.toEqual({ result: 'ok', restored: false });
    await expect(c.setField({ window: '263544', field: '42.7.1', value: 'Ada' }, signal())).resolves.toBe('refused');
  });

  it('waits up to 6 s for a paste', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { c, starts } = client(['silent', 'ok']);
    const req = { window: '263544', text: 'hello', click: null, mode: 'insert' as const, asked: '' };
    const outcome = c.paste(req, signal()).then(() => 'resolved', (e: unknown) => e);
    await vi.advanceTimersByTimeAsync(5999);
    expect(starts()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await outcome).toMatchObject({ code: 'timeout' });
    expect(starts()).toBe(2);
  });

  it('lets a running paste put the clipboard back before the helper stops', async () => {
    const { c } = client(['lagged']);
    // The fake writes this file as it answers the paste, after 1.5 s: longer than a stop's usual 1 s wait.
    const answered = join(tempDir(), 'pasted');
    const req = { window: '263544', text: answered, click: null, mode: 'insert' as const, asked: '' };
    const paste = c.paste(req, signal()).catch((e: unknown) => e);
    await c.stop();
    expect(existsSync(answered)).toBe(true);
    await paste;
  });

  it('gives a paste the time of each request still waiting ahead of it', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { c, starts } = client(['lagged']);
    const fg = c.foreground(signal());
    const req = { window: '263544', text: join(tempDir(), 'pasted'), click: null, mode: 'insert' as const, asked: '' };
    let settled = false;
    const paste = c.paste(req, signal()).finally(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(2900);
    await fg; // answered after the foreground's 3 s would have run out for a paste behind it
    await vi.advanceTimersByTimeAsync(3200); // 6.1 s since the paste was sent
    expect(settled).toBe(false);
    expect(starts()).toBe(1);
    await expect(paste).resolves.toEqual({ result: 'ok', restored: true });
  });

  it('gives a paste the time of an aborted request the helper still runs ahead of it', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { c, starts } = client(['lagged']);
    const ac = new AbortController();
    const fg = c.foreground(ac.signal).catch((e: unknown) => e);
    ac.abort();
    await fg;
    const req = { window: '263544', text: join(tempDir(), 'pasted'), click: null, mode: 'insert' as const, asked: '' };
    let settled = false;
    const paste = c.paste(req, signal()).finally(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(6100); // past a paste's own 6 s
    expect(settled).toBe(false);
    expect(starts()).toBe(1);
    await expect(paste).resolves.toEqual({ result: 'ok', restored: true });
  });

  it('gives a request behind a paste the paste\'s time too, so it never restarts the helper mid-paste', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { c, starts } = client(['silent', 'ok']);
    const req = { window: '263544', text: 'hello', click: null, mode: 'insert' as const, asked: '' };
    const paste = c.paste(req, signal()).then(() => 'resolved', (e: unknown) => e);
    let settled = false;
    const fg = c.foreground(signal()).then(() => 'resolved', (e: unknown) => e).finally(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(3000);
    expect(settled).toBe(false);
    expect(starts()).toBe(1);
    await vi.advanceTimersByTimeAsync(3000);
    expect(await paste).toMatchObject({ code: 'timeout' });
    expect(await fg).toMatchObject({ code: 'timeout' });
  });
});

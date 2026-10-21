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
    await expect(c.foreground(signal())).resolves.toEqual({ app: 'notepad', title: 'notes.txt - Notepad' });
  });

  it('rejects when aborted and ignores the late reply', async () => {
    const { c, starts } = client(['ok']);
    const ac = new AbortController();
    const shot = c.capture({ display, spots: [{ x: 10, y: 10 }], dir: tempDir() }, ac.signal);
    ac.abort();
    await expect(shot).rejects.toMatchObject({ code: 'aborted' });
    // The helper still answers the capture before this; that late line must not settle anything else.
    await expect(c.foreground(signal())).resolves.toEqual({ app: 'notepad', title: 'notes.txt - Notepad' });
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
    await expect(c.foreground(signal())).resolves.toEqual({ app: 'notepad', title: 'notes.txt - Notepad' });
  });

  it('passes on the helper\'s error code', async () => {
    const { c } = client(['denied']);
    await expect(c.capture({ display, spots: [], dir: tempDir() }, signal())).rejects.toMatchObject({ code: 'permission' });
  });

  it('reads every layer it asks for in one request', async () => {
    const { c } = client(['ok']);
    const dir = tempDir();
    const req = { spots: [{ x: 100.4, y: 200 }], radius: 600, marks: true, text: true, file: true, dir };
    const got = await c.read(req, signal());
    expect(got.status).toEqual({ marks: 'ok', text: 'ok', file: 'ok' });
    expect(got.marks?.count).toBe(1);
    expect(readFileSync(got.marks?.path ?? '', 'utf8')).toBe('button\t900\t700\t200\t60\tSave\n');
    expect(got.text).toEqual({ selection: 'chosen', spotTexts: ['under the spot'], focus: null, address: '' });
    expect(got.file).toEqual({ path: 'C:/docs/a.txt', address: '', how: 'title' });
    const sent: unknown = JSON.parse(readFileSync(join(dir, 'read-command.json'), 'utf8'));
    expect(sent).toMatchObject({ type: 'read', spots: '100,200', radius: 600, marks: true, text: true, file: true });
  });

  it('leaves out the layers it does not ask for', async () => {
    const { c } = client(['ok']);
    const got = await c.read({ spots: [], radius: 600, marks: false, text: true, file: false, dir: tempDir() }, signal());
    expect(got.status).toEqual({ marks: 'off', text: 'ok', file: 'off' });
    expect(got.marks).toBeNull();
    expect(got.file).toBeNull();
  });

  it('keeps what a helper read on its way out, and starts a new helper after it', async () => {
    const { c, starts } = client(['slow', 'ok']);
    const req = { spots: [{ x: 100, y: 200 }], radius: 600, marks: true, text: true, file: true, dir: tempDir() };
    const got = await c.read(req, signal());
    expect(got.status).toEqual({ marks: 'ok', text: 'ok', file: 'slow' });
    expect(got.marks?.count).toBe(1);
    expect(got.file).toBeNull();
    // The old helper is on its way out and reads nothing more: this request must go to a fresh one.
    await expect(c.foreground(signal())).resolves.toEqual({ app: 'notepad', title: 'notes.txt - Notepad' });
    expect(starts()).toBe(2);
  });

  it('rejects instead of throwing when the helper cannot start', async () => {
    const c = new ContextClient({ command: join(tmpdir(), 'definitely-missing-context-helper.exe') });
    clients.push(c);
    await expect(c.foreground(signal())).rejects.toMatchObject({ code: 'exited' });
  });
});

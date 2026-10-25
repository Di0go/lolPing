import { afterEach, describe, expect, it, vi } from 'vitest';
import { ContextError } from '../../../src/main/teammate/contextClient';
import type { Doc } from '../../../src/main/teammate/files';
import { gather, type GatherDeps, type GatherRequest } from '../../../src/main/teammate/gather';
import type { FileHow, LayerStatus, SystemTextLayer } from '../../../src/shared/teammate/contextProtocol';
import { PAGE_CHARS } from '../../../src/shared/teammate/locate';

const SPOT = { x: 1000, y: 800 };
const ALL_ON = { marks: true, systemText: true, files: true, webPdfs: false, clipboardForForms: false };
const layer = (over: Partial<SystemTextLayer> = {}): SystemTextLayer => ({
  selection: '', spotTexts: [], focus: null, address: '', ...over,
});

/** Six pages of about 2,500 characters; page 3 holds the sentence on screen. */
const VISIBLE = 'the quarterly revenue rose by nine percent';
const pages = (): Doc['sections'] => [1, 2, 3, 4, 5, 6].map((n) => ({
  label: `p. ${n}`,
  text: n === 3 ? `${VISIBLE} ${'a'.repeat(2_500 - VISIBLE.length - 1)}` : `page${n} `.repeat(400),
}));
const pdf = (name: string, sections: Doc['sections'] = pages()): Doc => ({ name, kind: 'pdf', outline: [], sections });

type Layer = 'marks' | 'text' | 'file' | 'fields';

const FIELDS_FILE = [
  { id: '42.7.1', kind: 'text', label: 'Customer name', group: '', value: 'Ada', secure: false, required: true, options: [] },
  { id: '42.7.2', kind: 'text', label: 'Password', group: '', value: 'hunter2', secure: true, required: false, options: [] },
].map((f) => JSON.stringify(f)).join('\n');

interface FakeOptions {
  /** The helper's fields file. */
  fieldsFile?: string;
  /** What the helper says about a layer it was asked for, instead of `ok`. */
  status?: Partial<Record<Layer, Exclude<LayerStatus, 'off' | 'ok'>>>;
  /** The read itself fails: the helper timed out, died, or the ask was cancelled. */
  readError?: Error;
  system?: SystemTextLayer;
  marksFile?: string;
  file?: { path: string; address: string; how: FileHow };
  doc?: Doc | Error;
}

function fakes(opts: FakeOptions = {}) {
  const calls: string[] = [];
  const fetched: string[] = [];
  const deps: GatherDeps = {
    context: {
      read: async (req) => {
        const asked = (['marks', 'text', 'file', 'boxes', 'fields'] as const).filter((l) => req[l]);
        calls.push(`read:${asked.join('+')}`);
        if (opts.readError) throw opts.readError;
        const status = (l: Layer): LayerStatus => (!req[l] ? 'off' : opts.status?.[l] ?? 'ok');
        return {
          status: {
            marks: status('marks'), text: status('text'), file: status('file'), boxes: req.boxes ? 'ok' : 'off',
            fields: status('fields'),
          },
          fields: status('fields') === 'ok' ? { path: `${req.dir}/fields.jsonl`, count: 2 } : null,
          marks: status('marks') === 'ok' ? { path: `${req.dir}/marks.tsv`, count: 1 } : null,
          text: status('text') === 'ok' ? opts.system ?? layer({ spotTexts: [VISIBLE] }) : null,
          file: status('file') === 'ok' ? opts.file ?? { path: 'C:/docs/report.pdf', address: '', how: 'title' } : null,
          boxes: req.boxes ? [[{ x: 900, y: 700, w: 200, h: 60 }, { x: 0, y: 0, w: 1920, h: 1040 }]] : null,
        };
      },
    },
    readFile: async (path) => {
      calls.push(`readFile:${path}`);
      if (path.endsWith('fields.jsonl')) return opts.fieldsFile ?? FIELDS_FILE;
      return opts.marksFile ?? 'button\t900\t700\t200\t60\tSave\n';
    },
    readDocument: async (path) => {
      calls.push(`readDocument:${path}`);
      if (opts.doc instanceof Error) throw opts.doc;
      return opts.doc ?? pdf('report.pdf');
    },
    fetchWebPdf: async (url) => {
      fetched.push(url);
      return Buffer.from('%PDF');
    },
    readPdfBuffer: async (name) => pdf(name),
  };
  return { deps, calls, fetched };
}

const request = (over: Partial<GatherRequest> = {}): GatherRequest => ({
  settings: ALL_ON, spots: [SPOT], dir: 'tmp/run', allin: true, title: 'report.pdf - Acrobat', act: false,
  ...over,
});
const signal = (): AbortSignal => new AbortController().signal;

afterEach(() => {
  vi.useRealTimers();
});

describe('gather', () => {
  it('runs only the layers that are on, in one helper read', async () => {
    const all = fakes();
    const got = await gather(all.deps, request(), signal());
    expect(all.calls).toEqual([
      'read:marks+text+file+boxes', 'readFile:tmp/run/marks.tsv', 'readDocument:C:/docs/report.pdf',
    ]);
    expect(got.boxes).toEqual([[{ x: 900, y: 700, w: 200, h: 60 }, { x: 0, y: 0, w: 1920, h: 1040 }]]);
    expect(got.marks).toEqual([{ kind: 'button', box: { x: 900, y: 700, w: 200, h: 60 }, text: 'Save' }]);
    expect(got.system).toEqual(layer({ spotTexts: [VISIBLE] }));
    expect(got.file?.doc.name).toBe('report.pdf');
    expect(got.doc?.name).toBe('report.pdf');
    expect(got.skipped).toBe(false);

    const some = fakes();
    const off = { ...ALL_ON, marks: false, files: false };
    const less = await gather(some.deps, request({ settings: off }), signal());
    expect(some.calls).toEqual(['read:text+boxes']);
    expect(less).toMatchObject({ marks: [], file: null, skipped: false });

    // Only Whole picture reads the file behind the window, so no other ask waits for it.
    const quick = fakes();
    const spot = await gather(quick.deps, request({ allin: false }), signal());
    expect(quick.calls).toEqual(['read:marks+text+boxes', 'readFile:tmp/run/marks.tsv']);
    expect(spot).toMatchObject({ file: null, doc: null });

    const none = fakes();
    const nothing = { ...ALL_ON, marks: false, systemText: false, files: false };
    const framed = await gather(none.deps, request({ settings: nothing }), signal());
    expect(none.calls).toEqual(['read:boxes']); // the boxes frame the capture whatever is read
    expect(framed.boxes).toHaveLength(1);
  });

  it('reads form fields only for Do it', async () => {
    const other = fakes();
    const idle = await gather(other.deps, request({ allin: false }), signal());
    expect(other.calls).toEqual(['read:marks+text+boxes', 'readFile:tmp/run/marks.tsv']);
    expect(idle.fields).toEqual([]);

    const act = fakes();
    const got = await gather(act.deps, request({ allin: false, act: true }), signal());
    expect(act.calls).toEqual(['read:marks+text+boxes+fields', 'readFile:tmp/run/marks.tsv', 'readFile:tmp/run/fields.jsonl']);
    // The password field is listed, but without its value.
    expect(got.fields.map((f) => [f.id, f.label, f.value, f.secure])).toEqual([
      ['42.7.1', 'Customer name', 'Ada', false],
      ['42.7.2', 'Password', '', true],
    ]);

    // The fields are system text: with that switch off, Do it does not read them either.
    const noText = fakes();
    const off = { ...ALL_ON, systemText: false };
    const none = await gather(noText.deps, request({ allin: false, act: true, settings: off }), signal());
    expect(noText.calls).toEqual(['read:marks+boxes', 'readFile:tmp/run/marks.tsv']);
    expect(none.fields).toEqual([]);
  });

  it('answers without fields when the helper was too slow or the file is bad', async () => {
    const slow = fakes({ status: { fields: 'slow' } });
    const got = await gather(slow.deps, request({ act: true }), signal());
    expect(got.fields).toEqual([]);
    expect(got.skipped).toBe(true);
    const refused = fakes({ status: { fields: 'permission' } });
    expect((await gather(refused.deps, request({ act: true }), signal())).fields).toEqual([]);
    const bad = fakes({ fieldsFile: 'not json\n' });
    expect((await gather(bad.deps, request({ act: true }), signal())).fields).toEqual([]);
  });

  it('keeps the 40 marks nearest the spot', async () => {
    // 60 buttons in a row to the right of the spot, 10 px apart.
    const row = Array.from({ length: 60 }, (_, i) => `button\t${1000 + i * 10}\t800\t8\t20\tB${i}`).join('\n');
    const got = await gather(fakes({ marksFile: row }).deps, request(), signal());
    expect(got.marks).toHaveLength(40);
    expect(got.marks.map((m) => m.text)).toContain('B0');
    expect(got.marks.map((m) => m.text)).not.toContain('B59');
  });

  it('answers without a layer the helper was too slow for', async () => {
    const f = fakes({ status: { text: 'slow' } });
    const got = await gather(f.deps, request(), signal());
    expect(got.system).toBeNull();
    expect(got.skipped).toBe(true);
    expect(got.marks).toHaveLength(1);
    expect(got.file).not.toBeNull();
    expect(got.used.map((u) => u.kind)).toEqual(['marks', 'file']);

    // The walk was too slow: what the other layers found is kept, and the footer says some context was skipped.
    const slowMarks = fakes({ status: { marks: 'slow' } });
    const rest = await gather(slowMarks.deps, request(), signal());
    expect(rest).toMatchObject({ marks: [], system: layer({ spotTexts: [VISIBLE] }), skipped: true });
    expect(slowMarks.calls).not.toContain('readFile:tmp/run/marks.tsv');

    const timedOut = fakes({ readError: new ContextError('timeout', 'no reply') });
    await expect(gather(timedOut.deps, request(), signal()))
      .resolves.toMatchObject({ marks: [], system: null, file: null, skipped: true });

    // A layer the system can't give (no permission) is left out without saying context was skipped.
    const denied = fakes({ status: { text: 'permission' } });
    await expect(gather(denied.deps, request(), signal())).resolves.toMatchObject({ system: null, skipped: false });
  });

  it('locates the visible part of the file', async () => {
    const f = fakes();
    const got = await gather(f.deps, request(), signal());
    // Page 3 holds the text at the spot; the six short pages all fit the 30-page budget around it.
    expect(got.file).toMatchObject({ from: 0, to: 5 });
    expect(got.used).toEqual([
      { kind: 'text' }, { kind: 'marks' }, { kind: 'file', name: 'report.pdf', unit: 'page', from: '1', to: '6' },
    ]);

    // One section bigger than the whole budget is cut to it in the prompt; read_file keeps the whole file.
    const big: Doc = {
      name: 'big.txt', kind: 'text', outline: [], sections: [{ label: 'part 1', text: 'z'.repeat(100_000) }],
    };
    const huge = fakes({ doc: big });
    const cut = await gather(huge.deps, request(), signal());
    expect(cut.file?.doc.sections[0].text).toHaveLength(PAGE_CHARS * 30);
    expect(cut.doc?.sections[0].text).toHaveLength(100_000);
    expect(cut.used).toContainEqual({ kind: 'file', name: 'big.txt', unit: 'part', from: '1', to: '1' });

    // An empty file, or one that can't be read, gives no file layer.
    const empty = fakes({ doc: { name: 'empty.txt', kind: 'text', outline: [], sections: [] } });
    await expect(gather(empty.deps, request(), signal())).resolves.toMatchObject({ file: null, skipped: false });
    const gone = fakes({ doc: new Error('ENOENT') });
    await expect(gather(gone.deps, request(), signal())).resolves.toMatchObject({ file: null, skipped: false });
  });

  it('fetches a web PDF only with web PDFs on', async () => {
    const web = { path: '', address: 'https://example.com/papers/q3%20report.pdf?dl=1', how: 'address' as const };
    const off = fakes({ file: web });
    await expect(gather(off.deps, request(), signal())).resolves.toMatchObject({ file: null });
    expect(off.fetched).toEqual([]);

    const settings = { ...ALL_ON, webPdfs: true };
    const on = fakes({ file: web });
    const got = await gather(on.deps, request({ settings }), signal());
    expect(on.fetched).toEqual([web.address]);
    expect(got.file?.doc.name).toBe('q3 report.pdf');
    expect(got.used).toContainEqual({ kind: 'file', name: 'q3 report.pdf', unit: 'page', from: '1', to: '6' });

    // An address without .pdf counts when the tab's title names a PDF.
    const titled = fakes({ file: { path: '', address: 'https://example.com/view?id=3', how: 'address' } });
    await gather(titled.deps, request({ settings, title: 'paper.pdf - Google Chrome' }), signal());
    expect(titled.fetched).toEqual(['https://example.com/view?id=3']);

    // Never a page that isn't a PDF, nor a browser's own page.
    for (const address of ['https://example.com/index.html', 'edge://settings/a.pdf']) {
      const other = fakes({ file: { path: '', address, how: 'address' } });
      await gather(other.deps, request({ settings, title: 'Example - Microsoft Edge' }), signal());
      expect(other.fetched).toEqual([]);
    }
  });

  it('skips a file that takes over 3 s to read', async () => {
    vi.useFakeTimers();
    const slow = fakes();
    slow.deps.readDocument = () => new Promise(() => undefined);
    let got: unknown = null;
    void gather(slow.deps, request(), signal()).then((g) => { got = g; });
    await vi.advanceTimersByTimeAsync(2_999);
    expect(got).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(got).toMatchObject({ file: null, doc: null, skipped: true });
    expect((got as { system: unknown }).system).not.toBeNull(); // the rest of the context still goes
  });

  it('skips a web PDF that takes over 10 s', async () => {
    vi.useFakeTimers();
    const web = fakes({ file: { path: '', address: 'https://example.com/slow.pdf', how: 'address' } });
    web.deps.fetchWebPdf = (_url, cut) => new Promise((_resolve, reject) => {
      cut.addEventListener('abort', () => reject(cut.reason), { once: true });
    });
    let got: unknown = null;
    void gather(web.deps, request({ settings: { ...ALL_ON, webPdfs: true } }), signal()).then((g) => { got = g; });
    await vi.advanceTimersByTimeAsync(9_999);
    expect(got).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(got).toMatchObject({ file: null, doc: null, skipped: true });
  });

  it('rethrows when the ask is cancelled', async () => {
    const f = fakes({ readError: new ContextError('aborted', 'the ask was cancelled') });
    await expect(gather(f.deps, request(), signal())).rejects.toMatchObject({ code: 'aborted' });
    expect(f.calls).toEqual(['read:marks+text+file+boxes']);

    // A download cut off by the cancel rejects with the signal's own error, which goes up as well.
    const ac = new AbortController();
    const web = fakes({ file: { path: '', address: 'https://example.com/a.pdf', how: 'address' } });
    web.deps.fetchWebPdf = async () => {
      ac.abort();
      throw new DOMException('This operation was aborted', 'AbortError');
    };
    await expect(gather(web.deps, request({ settings: { ...ALL_ON, webPdfs: true } }), ac.signal))
      .rejects.toThrow('aborted');
  });
});

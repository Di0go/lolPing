import { afterEach, describe, expect, it, vi } from 'vitest';
import { ContextError } from '../../../src/main/teammate/contextClient';
import type { Doc } from '../../../src/main/teammate/files';
import { gather, type GatherDeps, type GatherRequest } from '../../../src/main/teammate/gather';
import type { FileHow, SystemTextLayer } from '../../../src/shared/teammate/contextProtocol';
import { PAGE_CHARS } from '../../../src/shared/teammate/locate';

const SPOT = { x: 1000, y: 800 };
const ALL_ON = { marks: true, systemText: true, files: true, webPdfs: false, clipboardForForms: false };
const layer = (over: Partial<SystemTextLayer> = {}): SystemTextLayer => ({
  selection: '', spotTexts: [], focus: null, address: '', ...over,
});

/** Six pages of 25,000 characters; page 3 holds the sentence on screen. */
const VISIBLE = 'the quarterly revenue rose by nine percent';
const pages = (): Doc['sections'] => [1, 2, 3, 4, 5, 6].map((n) => ({
  label: `p. ${n}`,
  text: n === 3 ? `${VISIBLE} ${'a'.repeat(25_000 - VISIBLE.length - 1)}` : `page${n} `.repeat(4_000),
}));
const pdf = (name: string, sections: Doc['sections'] = pages()): Doc => ({ name, kind: 'pdf', outline: [], sections });

interface FakeOptions {
  system?: SystemTextLayer | Error;
  marks?: Error;
  /** The helper sent the marks it had and is exiting: a probe ran over its budget. */
  marksExiting?: boolean;
  marksFile?: string;
  file?: { path: string; address: string; how: FileHow } | Error;
  doc?: Doc | Error;
}

function fakes(opts: FakeOptions = {}) {
  const calls: string[] = [];
  const fetched: string[] = [];
  /** A slow probe makes the helper exit, and the capture's grab goes with it. */
  let grab = true;
  const failed = (err: Error): Error => {
    if (err instanceof ContextError && err.code === 'slow') grab = false;
    return err;
  };
  const deps: GatherDeps = {
    context: {
      systemText: async () => {
        calls.push('systemText');
        if (opts.system instanceof Error) throw failed(opts.system);
        return opts.system ?? layer({ spotTexts: [VISIBLE] });
      },
      marks: async (req) => {
        calls.push(`marks:${req.of}`);
        if (opts.marks) throw failed(opts.marks);
        if (!grab) throw new ContextError('bad', 'that capture is gone');
        return { path: `${req.dir}/marks.tsv`, count: 1, exiting: opts.marksExiting ?? false };
      },
      fileOf: async () => {
        calls.push('fileOf');
        if (opts.file instanceof Error) throw opts.file;
        return opts.file ?? { path: 'C:/docs/report.pdf', address: '', how: 'title' };
      },
    },
    readFile: async (path) => {
      calls.push(`readFile:${path}`);
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
  settings: ALL_ON, captureId: 'r2', spots: [SPOT], dir: 'tmp/run', allin: false, title: 'report.pdf - Acrobat',
  ...over,
});
const signal = (): AbortSignal => new AbortController().signal;

afterEach(() => {
  vi.useRealTimers();
});

describe('gather', () => {
  it('runs only the layers that are on', async () => {
    const all = fakes();
    const got = await gather(all.deps, request(), signal());
    // One after another: the helper answers one request at a time. Marks go first: a slow probe after them ends the
    // helper, and the capture's grab with it.
    expect(all.calls).toEqual([
      'marks:r2', 'readFile:tmp/run/marks.tsv', 'systemText', 'fileOf', 'readDocument:C:/docs/report.pdf',
    ]);
    expect(got.marks).toEqual([{ kind: 'button', box: { x: 900, y: 700, w: 200, h: 60 }, text: 'Save' }]);
    expect(got.system).toEqual(layer({ spotTexts: [VISIBLE] }));
    expect(got.file?.doc.name).toBe('report.pdf');
    expect(got.doc?.name).toBe('report.pdf');
    expect(got.skipped).toBe(false);

    const some = fakes();
    const off = { ...ALL_ON, marks: false, files: false };
    const less = await gather(some.deps, request({ settings: off }), signal());
    expect(some.calls).toEqual(['systemText']);
    expect(less).toMatchObject({ marks: [], file: null, skipped: false });

    const none = fakes();
    const nothing = { ...ALL_ON, systemText: false, files: false };
    await gather(none.deps, request({ settings: nothing, captureId: null }), signal());
    expect(none.calls).toEqual([]); // marks need the capture's grab
  });

  it('answers without a layer the helper was too slow for', async () => {
    const f = fakes({ system: new ContextError('slow', 'the system took too long to answer') });
    const got = await gather(f.deps, request(), signal());
    expect(got.system).toBeNull();
    expect(got.skipped).toBe(true);
    expect(got.marks).toHaveLength(1);
    expect(got.file).not.toBeNull();
    expect(got.used.map((u) => u.kind)).toEqual(['marks', 'file']);

    // Slow marks end the helper; the system text comes from a fresh one.
    const slowMarks = fakes({ marks: new ContextError('slow', 'OCR took too long') });
    const rest = await gather(slowMarks.deps, request(), signal());
    expect(rest).toMatchObject({ marks: [], system: layer({ spotTexts: [VISIBLE] }), skipped: true });

    // The OCR finished but the controls walk didn't: the marks found are kept, and the footer says some were skipped.
    const partial = fakes({ marksExiting: true });
    const kept = await gather(partial.deps, request(), signal());
    expect(kept.marks).toHaveLength(1);
    expect(kept.skipped).toBe(true);
    expect(kept.used.map((u) => u.kind)).toContain('marks');

    const timedOut = fakes({ marks: new ContextError('timeout', 'no reply') });
    await expect(gather(timedOut.deps, request(), signal())).resolves.toMatchObject({ marks: [], skipped: true });

    // A layer the system can't give (no permission, no OCR language) is left out without saying context was skipped.
    const denied = fakes({ system: new ContextError('permission', 'Accessibility is off') });
    await expect(gather(denied.deps, request(), signal())).resolves.toMatchObject({ system: null, skipped: false });
  });

  it('locates the visible part of the file', async () => {
    const f = fakes();
    const got = await gather(f.deps, request(), signal());
    // Page 3 holds the text at the spot; page 4 fits the 20-page budget beside it, page 2 would not.
    expect(got.file).toMatchObject({ from: 2, to: 3 });
    expect(got.used).toEqual([
      { kind: 'text' }, { kind: 'marks' }, { kind: 'file', name: 'report.pdf', unit: 'page', from: '3', to: '4' },
    ]);

    // One section bigger than the whole budget is cut to it in the prompt; read_file keeps the whole file.
    const big: Doc = {
      name: 'big.txt', kind: 'text', outline: [], sections: [{ label: 'part 1', text: 'z'.repeat(70_000) }],
    };
    const huge = fakes({ doc: big });
    const cut = await gather(huge.deps, request(), signal());
    expect(cut.file?.doc.sections[0].text).toHaveLength(PAGE_CHARS * 20);
    expect(cut.doc?.sections[0].text).toHaveLength(70_000);
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
    expect(got.used).toContainEqual({ kind: 'file', name: 'q3 report.pdf', unit: 'page', from: '3', to: '4' });

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
    const f = fakes({ marks: new ContextError('aborted', 'the ask was cancelled') });
    await expect(gather(f.deps, request(), signal())).rejects.toMatchObject({ code: 'aborted' });
    expect(f.calls).toEqual(['marks:r2']);

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

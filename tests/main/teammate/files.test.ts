import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { zipSync } from 'fflate';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  fetchWebPdf, FileReadError, MAX_PDF_PAGES, pdfAssetDirs, readDocument, readPdfBuffer,
} from '../../../src/main/teammate/files';
import { PAGE_CHARS } from '../../../src/shared/teammate/locate';
import { buildCjkPdf, buildDocx, buildPdf, buildPptx, buildXlsx, GBK_ZHONGWEN } from '../fixtures/files/build';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
let dir = '';
const at = (name: string): string => join(dir, name);
const write = (name: string, data: string | Uint8Array): string => {
  writeFileSync(at(name), data);
  return at(name);
};

const failure = async (p: Promise<unknown>): Promise<FileReadError> => {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(FileReadError);
    return e as FileReadError;
  }
  throw new Error('expected a FileReadError');
};

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'lolping-files-'));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('readDocument: text', () => {
  it('cuts text into 3000-character parts at line ends', async () => {
    const line = 'x'.repeat(99); // 100 characters with the newline
    const text = Array.from({ length: 70 }, () => line).join('\n');
    const doc = await readDocument(write('long.txt', text));
    expect(doc.kind).toBe('text');
    expect(doc.name).toBe('long.txt');
    expect(doc.sections.map((s) => s.label)).toEqual(['part 1', 'part 2', 'part 3']);
    for (const s of doc.sections) expect(s.text.length).toBeLessThanOrEqual(PAGE_CHARS);
    for (const s of doc.sections.slice(0, -1)) expect(s.text.endsWith(line)).toBe(true);
    expect(doc.sections.map((s) => s.text).join('\n')).toBe(text);
  });

  it('splits a single line longer than a part', async () => {
    const doc = await readDocument(write('one-line.txt', 'y'.repeat(PAGE_CHARS * 2 + 5)));
    expect(doc.sections.map((s) => s.text.length)).toEqual([PAGE_CHARS, PAGE_CHARS, 5]);
  });

  it('falls back to GB18030 when the bytes are not UTF-8', async () => {
    const bytes = Uint8Array.from([...GBK_ZHONGWEN, 0x0a, 0x41]);
    const doc = await readDocument(write('gbk.txt', bytes));
    expect(doc.sections[0].text).toBe('中文\nA');
  });

  it('reads UTF-8 with a byte order mark and UTF-16', async () => {
    const utf8 = Uint8Array.from([0xef, 0xbb, 0xbf, ...Buffer.from('héllo', 'utf8')]);
    expect((await readDocument(write('bom.txt', utf8))).sections[0].text).toBe('héllo');
    const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('hi 你好', 'utf16le')]);
    expect((await readDocument(write('u16.txt', utf16))).sections[0].text).toBe('hi 你好');
  });

  it('lists Markdown headings as the outline and skips fenced code', async () => {
    const md = '# Title\ntext\n## Part A\n```\n# not a heading\n```\n### Part B\n';
    const doc = await readDocument(write('notes.md', md));
    expect(doc.outline).toEqual(['Title', 'Part A', 'Part B']);
    expect((await readDocument(write('notes.txt', md))).outline).toEqual([]);
  });

  it('says unsupported for a binary file and for an unknown extension', async () => {
    expect((await failure(readDocument(write('a.txt', Uint8Array.from([65, 0, 0, 66]))))).code).toBe('unsupported');
    expect((await failure(readDocument(write('a.exe', 'hi')))).code).toBe('unsupported');
    expect((await failure(readDocument(write('a.doc', 'hi')))).code).toBe('unsupported');
  });

  it('says missing for a file that is not there', async () => {
    expect((await failure(readDocument(at('nope.txt')))).code).toBe('missing');
  });

  it('refuses a file over the cap', async () => {
    const path = write('big.txt', 'z'.repeat(200));
    expect((await failure(readDocument(path, { maxBytes: 100 }))).code).toBe('tooBig');
    expect((await readDocument(path, { maxBytes: 200 })).sections).toHaveLength(1);
  });
});

describe('pdfAssetDirs', () => {
  it('points at the copies beside a packaged app', () => {
    const dirs = pdfAssetDirs({ packaged: true, resourcesPath: join('app', 'resources'), appPath: join('app', 'x') });
    expect(dirs.cMapUrl).toBe(join('app', 'resources', 'pdfjs', 'cmaps') + '/');
    expect(dirs.standardFontDataUrl).toBe(join('app', 'resources', 'pdfjs', 'standard_fonts') + '/');
  });

  it('points into node_modules when running from source', () => {
    const appPath = join('src', 'repo');
    const dirs = pdfAssetDirs({ packaged: false, resourcesPath: join('app', 'resources'), appPath });
    expect(dirs.cMapUrl).toBe(join('src', 'repo', 'node_modules', 'pdfjs-dist', 'cmaps') + '/');
    expect(dirs.standardFontDataUrl).toBe(join('src', 'repo', 'node_modules', 'pdfjs-dist', 'standard_fonts') + '/');
  });
});

describe('readDocument: PDF', () => {
  it('reads PDF pages with their numbers', async () => {
    const doc = await readDocument(write('two.pdf', buildPdf(['Hello first page', 'Second page here'])));
    expect(doc.kind).toBe('pdf');
    expect(doc.sections.map((s) => s.label)).toEqual(['p. 1', 'p. 2']);
    expect(doc.sections[0].text).toContain('Hello first page');
    expect(doc.sections[1].text).toContain('Second page here');
    expect(doc.outline).toEqual(['Chapter 1', 'Chapter 2']);
  });

  it('reads a PDF from memory by name', async () => {
    const doc = await readPdfBuffer('web.pdf', buildPdf(['Only page']));
    expect(doc.name).toBe('web.pdf');
    expect(doc.sections.map((s) => s.label)).toEqual(['p. 1']);
  });

  it('reads Chinese text that only a predefined CMap can decode', async () => {
    const assets = pdfAssetDirs({ packaged: false, resourcesPath: '', appPath: repoRoot });
    const doc = await readDocument(write('cjk.pdf', buildCjkPdf()), assets);
    expect(doc.sections[0].text).toBe('中文');
  });

  it('leaves the event loop free between pages', async () => {
    const data = buildPdf(Array.from({ length: 60 }, (_, i) => `page ${i}`));
    await readPdfBuffer('warm.pdf', data); // the first read loads pdfjs, which has turns of its own
    let ticks = 0;
    const timer = setInterval(() => { ticks++; }, 0);
    try {
      const doc = await readPdfBuffer('many.pdf', data);
      expect(doc.sections).toHaveLength(60);
    } finally {
      clearInterval(timer);
    }
    expect(ticks).toBeGreaterThanOrEqual(5);
  });

  it('reads at most the page cap and keeps the outline', async () => {
    expect(MAX_PDF_PAGES).toBe(1000);
    const data = buildPdf(['one', 'two', 'three', 'four', 'five']);
    const doc = await readPdfBuffer('cap.pdf', data, { maxPages: 3 });
    expect(doc.sections.map((s) => s.label)).toEqual(['p. 1', 'p. 2', 'p. 3']);
    expect(doc.outline).toHaveLength(5);
  });

  it('says unreadable for a corrupt PDF', async () => {
    expect((await failure(readDocument(write('bad.pdf', '%PDF-1.4\nnot really')))).code).toBe('unreadable');
  });
});

describe('readDocument: Office', () => {
  it('reads docx text and headings', async () => {
    const doc = await readDocument(write('a.docx', buildDocx([
      { text: 'Report', heading: 'Title' },
      { text: 'Intro', heading: 1 },
      { text: 'First\tsecond & <third>' },
      { text: 'Details', heading: 2 },
      { text: 'More words' },
    ])));
    expect(doc.kind).toBe('docx');
    expect(doc.outline).toEqual(['Report', 'Intro', 'Details']);
    expect(doc.sections).toHaveLength(1);
    expect(doc.sections[0].label).toBe('part 1');
    expect(doc.sections[0].text).toBe('Report\nIntro\nFirst\tsecond & <third>\nDetails\nMore words');
  });

  it('reads slides in order', async () => {
    const slides = Array.from({ length: 11 }, (_, i) => ({ title: `Title ${i + 1}`, lines: [`Body ${i + 1}`] }));
    const doc = await readDocument(write('a.pptx', buildPptx(slides)));
    expect(doc.kind).toBe('pptx');
    expect(doc.sections.map((s) => s.label)).toEqual(slides.map((_, i) => `slide ${i + 1}`));
    expect(doc.sections[1].text).toBe('Title 2\nBody 2');
    expect(doc.sections[9].text).toBe('Title 10\nBody 10');
    expect(doc.outline.slice(0, 3)).toEqual(['Title 1', 'Title 2', 'Title 3']);
  });

  it('follows the deck order in presentation.xml, not the slide file numbers', async () => {
    const slides = [1, 2, 3].map((n) => ({ title: `Title ${n}`, lines: [`Body ${n}`] }));
    const doc = await readDocument(write('order.pptx', buildPptx(slides, [3, 1, 2])));
    expect(doc.sections.map((s) => s.label)).toEqual(['slide 1', 'slide 2', 'slide 3']);
    expect(doc.sections.map((s) => s.text)).toEqual(['Title 3\nBody 3', 'Title 1\nBody 1', 'Title 2\nBody 2']);
    expect(doc.outline).toEqual(['Title 3', 'Title 1', 'Title 2']);
  });

  it('reads every sheet as rows', async () => {
    const doc = await readDocument(write('a.xlsx', buildXlsx([
      { name: 'Budget', rows: [['Item', 'Cost'], ['Tea', 3], ['Rice', 12]] },
      { name: 'Notes', rows: [['Only', '', 'gap'], [7]] },
    ])));
    expect(doc.kind).toBe('xlsx');
    expect(doc.outline).toEqual(['Budget', 'Notes']);
    expect(doc.sections.map((s) => s.label)).toEqual(['sheet Budget', 'sheet Notes']);
    expect(doc.sections[0].text).toBe('Item\tCost\nTea\t3\nRice\t12');
    expect(doc.sections[1].text).toBe('Only\t\tgap\n7');
  });

  it('stops a sheet at 2000 rows', async () => {
    const rows = Array.from({ length: 2500 }, (_, i) => [i]);
    const doc = await readDocument(write('rows.xlsx', buildXlsx([{ name: 'Big', rows }])));
    expect(doc.sections[0].text.split('\n')).toHaveLength(2000);
  });

  it('says tooBig for a zip that unpacks past the budget instead of missing its text', async () => {
    const mb = (n: number): Uint8Array => new Uint8Array(n * 1024 * 1024);
    const one = zipSync({ 'word/document.xml': mb(101) }, { level: 1 });
    const err = await failure(readDocument(write('bomb.docx', one)));
    expect(err.code).toBe('tooBig');
    expect(err.message).toContain('word/document.xml');
    const two = zipSync({
      'xl/workbook.xml': new Uint8Array(10),
      'xl/worksheets/sheet1.xml': mb(60),
      'xl/worksheets/sheet2.xml': mb(60),
    }, { level: 1 });
    expect((await failure(readDocument(write('bomb.xlsx', two)))).code).toBe('tooBig');
  });

  it('says unreadable for a corrupt docx', async () => {
    expect((await failure(readDocument(write('bad.docx', 'this is not a zip')))).code).toBe('unreadable');
    const noBody = write('empty.docx', buildXlsx([{ name: 'S', rows: [['x']] }]));
    expect((await failure(readDocument(noBody))).code).toBe('unreadable');
  });
});

describe('fetchWebPdf', () => {
  let server: Server;
  let base = '';
  const closed = new Map<string, Promise<number>>();

  beforeAll(async () => {
    const pdf = buildPdf(['From the web']);
    server = createServer((req, res: ServerResponse) => {
      const url = req.url ?? '/';
      if (url === '/ok.pdf') {
        res.writeHead(200, { 'content-type': 'application/pdf' }).end(pdf);
      } else if (url === '/redirect') {
        res.writeHead(302, { location: '/ok.pdf' }).end();
      } else if (url === '/page.html') {
        res.writeHead(200, { 'content-type': 'text/html' }).end('<html>' + 'a'.repeat(2000) + '</html>');
      } else if (url === '/missing') {
        res.writeHead(404).end('no');
      } else if (url === '/endless.pdf') {
        // No content-length: the client has to count what arrives.
        res.writeHead(200, { 'content-type': 'application/pdf' });
        let sent = 0;
        const chunk = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(16 * 1024, 0x20)]);
        closed.set(url, new Promise((done) => res.on('close', () => done(sent))));
        const push = (): void => {
          if (res.destroyed) return;
          sent++;
          res.write(chunk, () => setImmediate(push));
        };
        push();
      }
    });
    await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((ok) => { server.closeAllConnections(); server.close(() => ok()); }));

  it('downloads a PDF, following a redirect', async () => {
    const data = await fetchWebPdf(`${base}/redirect`, new AbortController().signal);
    const doc = await readPdfBuffer('ok.pdf', data);
    expect(doc.sections[0].text).toContain('From the web');
  });

  it('stops a web PDF download past the cap', async () => {
    const err = await failure(fetchWebPdf(`${base}/endless.pdf`, new AbortController().signal, 100 * 1024));
    expect(err.code).toBe('tooBig');
    const sent = await closed.get('/endless.pdf');
    expect(sent).toBeLessThan(200);
  });

  it('refuses a web page that is not a PDF', async () => {
    const err = await failure(fetchWebPdf(`${base}/page.html`, new AbortController().signal));
    expect(err.code).toBe('unsupported');
  });

  it('refuses other schemes, error statuses and an aborted request', async () => {
    expect((await failure(fetchWebPdf('file:///etc/passwd', new AbortController().signal))).code).toBe('unsupported');
    expect((await failure(fetchWebPdf(`${base}/missing`, new AbortController().signal))).code).toBe('unreadable');
    const stop = new AbortController();
    stop.abort();
    await expect(fetchWebPdf(`${base}/ok.pdf`, stop.signal)).rejects.toThrow();
  });
});

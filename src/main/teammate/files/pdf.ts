import { join } from 'node:path';
import { FileReadError, MAX_OUTLINE, type Doc } from './doc';

type PdfJs = typeof import('pdfjs-dist/legacy/build/pdf.mjs');

declare global {
  // pdfjs looks here for an in-process worker; with it set, no worker file is needed at run time.
  var pdfjsWorker: { WorkerMessageHandler: unknown } | undefined;
}

let loading: Promise<PdfJs> | undefined;

/** Loads pdfjs on first use, so the app does not pay for it until a PDF is read. */
function pdfjs(): Promise<PdfJs> {
  loading ??= (async () => {
    globalThis.pdfjsWorker = await import('pdfjs-dist/legacy/build/pdf.worker.mjs');
    return import('pdfjs-dist/legacy/build/pdf.mjs');
  })();
  // A failed load must not stick: the next PDF tries again.
  loading.catch(() => { loading = undefined; });
  return loading;
}

interface OutlineNode { title: string; items: OutlineNode[] }

function flattenOutline(nodes: readonly OutlineNode[], out: string[]): void {
  for (const n of nodes) {
    if (out.length >= MAX_OUTLINE) return;
    const title = n.title.trim();
    if (title) out.push(title);
    flattenOutline(n.items, out);
  }
}

/** More pages than this are not read; a huge PDF would hold main for seconds. */
export const MAX_PDF_PAGES = 1000;

export interface PdfReadOptions {
  /** Directory of pdfjs's predefined CMaps (ending in a slash); Chinese PDFs without ToUnicode need it. */
  cMapUrl?: string;
  /** Directory of pdfjs's standard font files (ending in a slash). */
  standardFontDataUrl?: string;
  maxPages?: number;
}

/**
 * Where pdfjs's CMaps and standard fonts are: copied beside the app when packaged (see `extraResources` in
 * package.json), in node_modules when running from source.
 * Both end with a slash, which pdfjs insists on even on Windows.
 */
export function pdfAssetDirs(
  base: { packaged: boolean; resourcesPath: string; appPath: string },
): { cMapUrl: string; standardFontDataUrl: string } {
  const root = base.packaged ? join(base.resourcesPath, 'pdfjs') : join(base.appPath, 'node_modules', 'pdfjs-dist');
  return {
    cMapUrl: join(root, 'cmaps') + '/',
    standardFontDataUrl: join(root, 'standard_fonts') + '/',
  };
}

/** Reads a PDF's text page by page; any failure, a password included, is `unreadable`. */
export async function readPdfBuffer(name: string, data: Buffer, opts: PdfReadOptions = {}): Promise<Doc> {
  const lib = await pdfjs().catch((e: unknown) => {
    throw new FileReadError('unreadable', `PDF reader failed to load: ${String(e)}`);
  });
  // pdfjs takes ownership of the array it is given, so it gets a copy.
  const task = lib.getDocument({
    data: new Uint8Array(data),
    useSystemFonts: false,
    disableFontFace: true,
    verbosity: lib.VerbosityLevel.ERRORS,
    cMapUrl: opts.cMapUrl,
    cMapPacked: true,
    standardFontDataUrl: opts.standardFontDataUrl,
  });
  try {
    const pdf = await task.promise;
    const sections: Doc['sections'] = [];
    const pages = Math.min(pdf.numPages, opts.maxPages ?? MAX_PDF_PAGES);
    for (let i = 1; i <= pages; i++) {
      // pdfjs's in-process worker is a chain of microtasks; without a turn of the event loop between pages
      // main's timers and IPC wait for the whole file.
      await new Promise<void>((resolve) => setImmediate(resolve));
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      let text = '';
      for (const item of content.items) {
        if ('str' in item) text += item.hasEOL ? `${item.str}
` : item.str;
      }
      sections.push({ label: `p. ${i}`, text: text.trim() });
      page.cleanup();
    }
    const outline: string[] = [];
    flattenOutline((await pdf.getOutline().catch(() => null)) ?? [], outline);
    return { name, kind: 'pdf', outline, sections };
  } catch (e) {
    throw new FileReadError('unreadable', `cannot read the PDF: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    await task.destroy().catch(() => undefined);
  }
}

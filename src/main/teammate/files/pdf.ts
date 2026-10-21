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

/** Reads a PDF's text page by page; any failure, a password included, is `unreadable`. */
export async function readPdfBuffer(name: string, data: Buffer): Promise<Doc> {
  const lib = await pdfjs().catch((e: unknown) => {
    throw new FileReadError('unreadable', `PDF reader failed to load: ${String(e)}`);
  });
  // pdfjs takes ownership of the array it is given, so it gets a copy.
  const task = lib.getDocument({
    data: new Uint8Array(data),
    useSystemFonts: false,
    disableFontFace: true,
    verbosity: lib.VerbosityLevel.ERRORS,
  });
  try {
    const pdf = await task.promise;
    const sections: Doc['sections'] = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      let text = '';
      for (const item of content.items) {
        if ('str' in item) text += item.hasEOL ? `${item.str}\n` : item.str;
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

import { readFile, stat } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { FileReadError, MAX_FILE_BYTES, type Doc } from './doc';
import { readDocx, readPptx, readXlsx } from './office';
import { readPdfBuffer, type PdfReadOptions } from './pdf';
import { readTextBytes, TEXT_EXTENSIONS } from './text';

export { FileReadError, type Doc, type FileReadCode } from './doc';
export { MAX_PDF_PAGES, pdfAssetDirs, readPdfBuffer, type PdfReadOptions } from './pdf';
export { fetchWebPdf } from './webPdf';

/** Reads a file the user pointed at into labelled sections; the file's extension picks the reader. */
export async function readDocument(path: string, opts: PdfReadOptions & { maxBytes?: number } = {}): Promise<Doc> {
  const name = basename(path);
  const ext = extname(path).toLowerCase();
  if (ext !== '.pdf' && ext !== '.docx' && ext !== '.pptx' && ext !== '.xlsx' && !TEXT_EXTENSIONS.has(ext)) {
    throw new FileReadError('unsupported', `${ext || 'this kind of file'} is not read`);
  }
  let size: number;
  try {
    const info = await stat(path);
    if (!info.isFile()) throw new FileReadError('unreadable', 'not a file');
    size = info.size;
  } catch (e) {
    if (e instanceof FileReadError) throw e;
    const code = (e as NodeJS.ErrnoException).code;
    throw new FileReadError(code === 'ENOENT' || code === 'ENOTDIR' ? 'missing' : 'unreadable', `cannot open ${name}`);
  }
  if (size > (opts.maxBytes ?? MAX_FILE_BYTES)) throw new FileReadError('tooBig', `${name} is over the size cap`);
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    throw new FileReadError(code === 'ENOENT' ? 'missing' : 'unreadable', `cannot read ${name}`);
  }
  switch (ext) {
    case '.pdf': return readPdfBuffer(name, bytes, opts);
    case '.docx': return readDocx(name, bytes);
    case '.pptx': return readPptx(name, bytes);
    case '.xlsx': return readXlsx(name, bytes);
    default: return readTextBytes(name, ext, bytes);
  }
}

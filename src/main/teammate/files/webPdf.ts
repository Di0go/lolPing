import { FileReadError, MAX_FILE_BYTES } from './doc';

const PDF_MAGIC = Buffer.from('%PDF');

/**
 * Downloads a PDF the user is viewing. Plain `fetch` with no cookies or credentials; http(s) only; the body is
 * counted as it arrives and dropped once it passes `maxBytes`. An abort rejects with the signal's own error.
 */
export async function fetchWebPdf(url: string, signal: AbortSignal, maxBytes = MAX_FILE_BYTES): Promise<Buffer> {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    throw new FileReadError('unsupported', 'not a web address');
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    throw new FileReadError('unsupported', 'only http and https addresses are fetched');
  }
  try {
    const res = await fetch(target, { signal, redirect: 'follow', credentials: 'omit' });
    if (!res.ok || !res.body) {
      await res.body?.cancel().catch(() => undefined);
      throw new FileReadError('unreadable', `the server answered ${res.status}`);
    }
    const declared = Number(res.headers.get('content-length'));
    if (declared > maxBytes) {
      await res.body.cancel();
      throw new FileReadError('tooBig', 'the PDF is over the size cap');
    }
    const chunks: Buffer[] = [];
    let total = 0;
    const reader = res.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
        if (total === 0 && chunk.length >= PDF_MAGIC.length && !chunk.subarray(0, 4).equals(PDF_MAGIC)) {
          throw new FileReadError('unsupported', 'the address is not a PDF');
        }
        chunks.push(chunk);
        total += chunk.length;
        if (total > maxBytes) throw new FileReadError('tooBig', 'the PDF is over the size cap');
      }
    } finally {
      // Stops the download when we leave early; a no-op after the last chunk.
      await reader.cancel().catch(() => undefined);
    }
    const data = Buffer.concat(chunks);
    if (!data.subarray(0, 4).equals(PDF_MAGIC)) throw new FileReadError('unsupported', 'the address is not a PDF');
    return data;
  } catch (e) {
    if (e instanceof FileReadError || signal.aborted) throw e;
    throw new FileReadError('unreadable', `cannot fetch the PDF: ${e instanceof Error ? e.message : String(e)}`);
  }
}

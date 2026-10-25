import { PAGE_CHARS } from '../../../shared/teammate/locate';
import { FileReadError, MAX_OUTLINE, type Doc } from './doc';

/**
 * Text-like extensions the teammate reads as plain text (lower case, with the dot). The context helper's
 * kFileExtensions (native/hook-helper/src/context.cpp) lists them too, to find a file by a window title: keep both.
 */
export const TEXT_EXTENSIONS: ReadonlySet<string> = new Set([
  '.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.jsonl', '.log', '.xml', '.yaml', '.yml', '.toml', '.ini',
  '.cfg', '.conf', '.srt', '.vtt', '.tex', '.rst', '.html', '.htm', '.css',
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.java', '.kt', '.c', '.h', '.cpp', '.hpp', '.cs', '.go', '.rs',
  '.rb', '.php', '.swift', '.sh', '.bat', '.ps1', '.sql',
]);

/** Cuts text into parts of at most `PAGE_CHARS` at line ends; a line longer than a part is cut where it falls. */
export function cutParts(text: string): { label: string; text: string }[] {
  const parts: string[] = [];
  let cur = '';
  const flush = (): void => {
    if (cur) parts.push(cur);
    cur = '';
  };
  for (const line of text.split('\n')) {
    if (cur && cur.length + 1 + line.length > PAGE_CHARS) flush();
    let rest = line;
    while (rest.length > PAGE_CHARS) {
      flush();
      parts.push(rest.slice(0, PAGE_CHARS));
      rest = rest.slice(PAGE_CHARS);
    }
    cur = cur ? `${cur}\n${rest}` : rest;
  }
  flush();
  return parts.map((t, i) => ({ label: `part ${i + 1}`, text: t }));
}

function decode(bytes: Uint8Array): string {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes);
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes);
  // NUL bytes mean a binary file; UTF-16 was handled above by its byte order mark.
  if (bytes.subarray(0, 8192).includes(0)) throw new FileReadError('unsupported', 'not a text file');
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('gb18030').decode(bytes);
  }
}

function markdownOutline(text: string): string[] {
  const out: string[] = [];
  let fenced = false;
  for (const line of text.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    else if (!fenced) {
      const m = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
      if (m) out.push(m[1]);
    }
    if (out.length >= MAX_OUTLINE) break;
  }
  return out;
}

export function readTextBytes(name: string, ext: string, bytes: Uint8Array): Doc {
  const text = decode(bytes).replace(/\r\n?/g, '\n');
  const outline = ext === '.md' || ext === '.markdown' ? markdownOutline(text) : [];
  return { name, kind: 'text', outline, sections: cutParts(text) };
}

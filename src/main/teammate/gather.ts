import type { Point } from '../../shared/ipc';
import type { SystemTextLayer } from '../../shared/teammate/contextProtocol';
import { locate, PAGE_CHARS } from '../../shared/teammate/locate';
import { parseMarksFile, selectMarks, type Mark } from '../../shared/teammate/marks';
import type { TeammateSettings } from '../../shared/teammate/settings';
import { ContextError, type ContextClient } from './contextClient';
import type { Doc, fetchWebPdf, readDocument, readPdfBuffer } from './files';

export interface GatherDeps {
  context: Pick<ContextClient, 'marks' | 'systemText' | 'fileOf'>;
  /** Reads the helper's marks file. */
  readFile(path: string): Promise<string>;
  readDocument: typeof readDocument;
  fetchWebPdf: typeof fetchWebPdf;
  readPdfBuffer: typeof readPdfBuffer;
}

export interface GatherRequest {
  settings: TeammateSettings['context'];
  /** The ask's capture, whose grab the marks are read from; null: no marks. */
  captureId: string | null;
  spots: Point[];
  dir: string;
  /** Whole picture reads a larger part of the file. */
  allin: boolean;
  /** The foreground window's title: a browser tab showing a PDF names it there. */
  title: string;
}

/** What the answer used, for the card footer; `from` and `to` are section labels. */
export type UsedItem =
  | { kind: 'selection' | 'text' | 'marks' | 'address' }
  | { kind: 'file'; name: string; from: string; to: string };

export interface Gathered {
  marks: Mark[];
  system: SystemTextLayer | null;
  file: { doc: Doc; from: number; to: number } | null;
  used: UsedItem[];
  /** A layer was dropped because the helper was too slow or died: the footer says so. */
  skipped: boolean;
}

/** Spec §6.1: marks within 600 px of a spot, at most 150. */
const MARK_RADIUS = 600;
const MAX_MARKS = 150;
/** Enough screen text to find the page by, while normalising it stays cheap. */
const MAX_VISIBLE = 4000;

/** The file text an ask may carry: about 20 pages, or 100 for Whole picture. */
export const fileBudget = (allin: boolean): number => PAGE_CHARS * (allin ? 100 : 20);

/** A web PDF to fetch: the address ends in `.pdf`, or the tab title names one. Its name comes from the same place. */
function webPdf(address: string, title: string): { url: string; name: string } | null {
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    return null;
  }
  // The helper also reports a browser's own pages (edge://, chrome://); only the web is fetched.
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  const last = url.pathname.split('/').pop() ?? '';
  if (/\.pdf$/i.test(last)) {
    let name = last;
    try {
      name = decodeURIComponent(last);
    } catch {
      // keep the encoded name
    }
    return { url: address, name };
  }
  const named = /[^\s/\\]+\.pdf(?![\p{L}\p{N}])/iu.exec(title);
  return named ? { url: address, name: named[0] } : null;
}

/** Cuts text to `max` UTF-16 units without leaving half a surrogate pair. */
function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
}

/** The located sections; one section larger than the budget on its own is cut to it. */
function located(doc: Doc, visible: string, budget: number): Gathered['file'] {
  const range = locate(doc.sections, visible, budget);
  if (!range) return null;
  const { from, to } = range;
  const size = doc.sections.slice(from, to + 1).reduce((n, s) => n + s.text.length, 0);
  if (size <= budget) return { doc, from, to };
  const sections = doc.sections.map((s, i) => (i === from ? { ...s, text: clip(s.text, budget) } : s));
  return { doc: { ...doc, sections }, from, to: from };
}

/**
 * Runs the context layers that are on for one ask, one after another (the helper answers one request at a time). A
 * layer that fails is left out; a cancelled ask rejects.
 */
export async function gather(deps: GatherDeps, req: GatherRequest, signal: AbortSignal): Promise<Gathered> {
  const out: Gathered = { marks: [], system: null, file: null, used: [], skipped: false };
  /** Runs one step; a failure leaves its layer out, and one from a slow or dead helper says context was skipped. */
  const step = async <T>(run: () => Promise<T>): Promise<T | null> => {
    try {
      return await run();
    } catch (err) {
      if (signal.aborted || (err instanceof ContextError && err.code === 'aborted')) throw err;
      if (err instanceof ContextError && (err.code === 'timeout' || err.code === 'slow' || err.code === 'exited')) {
        out.skipped = true;
      }
      return null;
    }
  };
  const { settings } = req;

  if (settings.systemText) out.system = await step(() => deps.context.systemText(req.spots, signal));

  const { captureId } = req;
  if (settings.marks && captureId !== null) {
    const marks = await step(async () => {
      const found = await deps.context.marks({
        of: captureId, spots: req.spots, radius: MARK_RADIUS, ocr: true, controls: true, dir: req.dir,
      }, signal);
      return selectMarks(parseMarksFile(await deps.readFile(found.path)), req.spots, {
        radius: MARK_RADIUS, max: MAX_MARKS,
      });
    });
    out.marks = marks ?? [];
  }

  if (settings.files) {
    const behind = await step(() => deps.context.fileOf(signal));
    const web = behind && behind.path === '' && settings.webPdfs ? webPdf(behind.address, req.title) : null;
    const doc = await step(async () => {
      if (behind && behind.path !== '') return deps.readDocument(behind.path);
      if (web) return deps.readPdfBuffer(web.name, await deps.fetchWebPdf(web.url, signal));
      return null;
    });
    if (doc) {
      const visible = [...(out.system?.spotTexts ?? []), ...out.marks.map((m) => m.text)].join('\n');
      out.file = located(doc, visible.slice(0, MAX_VISIBLE), fileBudget(req.allin));
    }
  }

  // Reading a file can't be cancelled midway; a cancel during it still ends here.
  if (signal.aborted) throw new ContextError('aborted', 'the ask was cancelled');
  const { system, file } = out;
  if (system?.selection) out.used.push({ kind: 'selection' });
  if (system && (system.spotTexts.some((t) => t !== '') || system.focus)) out.used.push({ kind: 'text' });
  if (system?.address) out.used.push({ kind: 'address' });
  if (out.marks.length > 0) out.used.push({ kind: 'marks' });
  if (file) {
    const { doc, from, to } = file;
    out.used.push({ kind: 'file', name: doc.name, from: doc.sections[from].label, to: doc.sections[to].label });
  }
  return out;
}

/** "p. 3" and "p. 4" read as "p. 3–4"; labels without a shared prefix as "sheet A–sheet B". */
export function fileRange(from: string, to: string): string {
  if (from === to) return from;
  const a = /^(.*?)(\d+)$/.exec(from);
  const b = /^(.*?)(\d+)$/.exec(to);
  return a && b && a[1] === b[1] ? `${from}–${b[2]}` : `${from}–${to}`;
}

export const ALL_READ = "That's all of the file you can read for this ask.";
const MAX_HITS = 3;

/**
 * Answers one `read_file` call from the ask's file: pages by section number from 1, or the first sections that hold
 * the search words, ignoring case. `served` characters of file text were given before; past `limit` nothing more is.
 */
export function readFileTool(
  doc: Doc,
  req: { pages?: { from: number; to: number }; search?: string },
  served: number,
  limit: number,
): { text: string; served: number } {
  let picked: Doc['sections'];
  if (req.pages) {
    picked = doc.sections.slice(req.pages.from - 1, req.pages.to);
    if (picked.length === 0) {
      const text = `The file has ${doc.sections.length} sections, so there is no section ${req.pages.from}.`;
      return { text, served };
    }
  } else {
    const words = (req.search ?? '').toLowerCase();
    picked = doc.sections.filter((s) => s.text.toLowerCase().includes(words)).slice(0, MAX_HITS);
    if (picked.length === 0) return { text: `No part of the file contains "${req.search ?? ''}".`, served };
  }
  let left = limit - served;
  if (left <= 0) return { text: ALL_READ, served };
  const parts: string[] = [];
  let cut = false;
  for (const s of picked) {
    if (left <= 0) {
      cut = true;
      break;
    }
    const text = clip(s.text, left);
    parts.push(`${s.label}:\n${text}`);
    left -= text.length;
    if (text.length < s.text.length) {
      cut = true;
      break;
    }
  }
  if (cut) parts.push(ALL_READ);
  return { text: parts.join('\n\n'), served: limit - left };
}

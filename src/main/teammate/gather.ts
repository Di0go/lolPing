import type { FileUnit } from '../../shared/i18n';
import type { Point } from '../../shared/ipc';
import { parseFieldsFile, type SystemTextLayer } from '../../shared/teammate/contextProtocol';
import type { Rect } from '../../shared/teammate/coords';
import type { FormField } from '../../shared/teammate/doRules';
import { locate, PAGE_CHARS } from '../../shared/teammate/locate';
import { parseMarksFile, selectMarks, type Mark } from '../../shared/teammate/marks';
import type { TeammateSettings } from '../../shared/teammate/settings';
import { ContextError, type ContextClient } from './contextClient';
import type { Doc, fetchWebPdf, readDocument, readPdfBuffer } from './files';

export interface GatherDeps {
  context: Pick<ContextClient, 'read'>;
  /** Reads the helper's marks file. */
  readFile(path: string): Promise<string>;
  readDocument: typeof readDocument;
  fetchWebPdf: typeof fetchWebPdf;
  readPdfBuffer: typeof readPdfBuffer;
}

export interface GatherRequest {
  settings: TeammateSettings['context'];
  spots: Point[];
  dir: string;
  /** Only Whole picture reads the file behind the window: every other ask answers faster without it. */
  allin: boolean;
  /** The foreground window's title: a browser tab showing a PDF names it there. */
  title: string;
  /** A Do it ask: only it reads the form fields, as only it can fill them. */
  act: boolean;
}

/** What the answer used, for the card footer; a file's `from` and `to` are section numbers or sheet names. */
export type UsedItem =
  | { kind: 'selection' | 'text' | 'marks' | 'address' }
  | { kind: 'file'; name: string; unit: FileUnit; from: string; to: string };

export interface Gathered {
  /** Per spot, the boxes around the element under it, innermost first, ending with its window; empty when unknown. */
  boxes: Rect[][];
  marks: Mark[];
  system: SystemTextLayer | null;
  /** The form fields in the window under the first spot; empty unless the ask read them. */
  fields: FormField[];
  /** The located sections for the prompt; a single section over the budget is cut there. */
  file: { doc: Doc; from: number; to: number } | null;
  /** The whole file, uncut, for read_file. */
  doc: Doc | null;
  used: UsedItem[];
  /** A layer was dropped because the helper was too slow or died: the footer says so. */
  skipped: boolean;
}

/** Marks within 600 px of a spot, the nearest 40: enough to aim by, few enough to keep the prompt short. */
const MARK_RADIUS = 600;
const MAX_MARKS = 40;
/** Enough screen text to find the page by, while normalising it stays cheap. */
const MAX_VISIBLE = 4000;
/** A web PDF that takes longer is left out, so the ask isn't held up by a slow server. */
const WEB_PDF_MS = 10_000;
/** A file that takes longer to read is left out, so one huge PDF can't hold every ask up. */
const FILE_READ_MS = 3_000;

const UNITS: Record<Doc['kind'], FileUnit> = { pdf: 'page', pptx: 'slide', xlsx: 'sheet', docx: 'part', text: 'part' };

/** A section label without its unit: "p. 3" is 3, "sheet Budget" is Budget. */
const sectionRef = (label: string): string => label.replace(/^(?:p\.|slide|sheet|part) /, '');

/**
 * The file text a Whole picture ask carries up front: about 30 pages around the one on screen. Every page is input the
 * model reads before its first word; read_file fetches more when the answer needs it.
 */
const FILE_BUDGET = PAGE_CHARS * 30;

/** How much file text read_file may give in one ask on top: about 200 pages. */
export const FILE_READ_LIMIT = PAGE_CHARS * 200;

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

/** `read`, or a `timeout` rejection once it has taken `ms`; the read itself can't be stopped and is left to finish. */
async function within<T>(read: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_resolve, reject) => {
    // A ContextError so the step counts it as skipped context, like a helper that was too slow.
    timer = setTimeout(() => reject(new ContextError('timeout', 'the file took too long to read')), ms);
  });
  try {
    return await Promise.race([read, late]);
  } finally {
    clearTimeout(timer);
  }
}

/** Downloads a web PDF, or rejects with `timeout` once it has taken WEB_PDF_MS. */
async function fetchWithin(deps: GatherDeps, url: string, signal: AbortSignal): Promise<Buffer> {
  const late = new AbortController();
  const timer = setTimeout(() => late.abort(), WEB_PDF_MS);
  try {
    return await deps.fetchWebPdf(url, AbortSignal.any([signal, late.signal]));
  } catch (err) {
    // A ContextError so the step counts it as skipped context, like a helper that was too slow.
    if (late.signal.aborted && !signal.aborted) throw new ContextError('timeout', 'the PDF took too long to download');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Runs the context layers that are on for one ask, and the boxes that frame its capture: one helper read, side by
 * side, then the marks file and the file behind the window. A layer that fails is left out; a cancelled ask rejects.
 */
export async function gather(deps: GatherDeps, req: GatherRequest, signal: AbortSignal): Promise<Gathered> {
  const out: Gathered = {
    boxes: [], marks: [], system: null, fields: [], file: null, doc: null, used: [], skipped: false,
  };
  /** Runs one step; a failure leaves its layer out, and one from a slow or dead helper says context was skipped. */
  const step = async <T>(run: () => Promise<T>): Promise<T | null> => {
    try {
      return await run();
    } catch (err) {
      if (signal.aborted || (err instanceof ContextError && err.code === 'aborted')) throw err;
      if (err instanceof ContextError && (err.code === 'timeout' || err.code === 'exited')) {
        out.skipped = true;
      }
      return null;
    }
  };
  const { settings } = req;
  // The boxes are only geometry, read for every ask whatever the settings: they frame the capture.
  const layers = {
    marks: settings.marks, text: settings.systemText, file: settings.files && req.allin, boxes: true,
    // Field values are system text like the focused field's, so the same switch covers them.
    fields: req.act && settings.systemText,
  };
  const ask = { spots: req.spots, radius: MARK_RADIUS, ...layers, dir: req.dir };
  const read = await step(() => deps.context.read(ask, signal));
  out.boxes = read?.boxes ?? [];
  // A layer still running at the helper's budget is left out, and the footer says some context was skipped.
  if (read && Object.values(read.status).includes('slow')) out.skipped = true;

  const found = read?.marks;
  if (found) {
    const marks = await step(async () => selectMarks(parseMarksFile(await deps.readFile(found.path)), req.spots, {
      radius: MARK_RADIUS, max: MAX_MARKS,
    }));
    out.marks = marks ?? [];
  }
  out.system = read?.text ?? null;

  const form = read?.fields;
  if (form) {
    const fields = await step(async () => parseFieldsFile(await deps.readFile(form.path)));
    out.fields = fields ?? [];
  }

  const behind = read?.file ?? null;
  if (behind) {
    const web = behind.path === '' && settings.webPdfs ? webPdf(behind.address, req.title) : null;
    const doc = await step(async () => {
      if (behind.path !== '') return within(deps.readDocument(behind.path), FILE_READ_MS);
      if (web) return within(deps.readPdfBuffer(web.name, await fetchWithin(deps, web.url, signal)), FILE_READ_MS);
      return null;
    });
    if (doc && doc.sections.length > 0) {
      out.doc = doc;
      const visible = [...(out.system?.spotTexts ?? []), ...out.marks.map((m) => m.text)].join('\n');
      out.file = located(doc, visible.slice(0, MAX_VISIBLE), FILE_BUDGET);
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
    out.used.push({
      kind: 'file', name: doc.name, unit: UNITS[doc.kind],
      from: sectionRef(doc.sections[from].label), to: sectionRef(doc.sections[to].label),
    });
  }
  return out;
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

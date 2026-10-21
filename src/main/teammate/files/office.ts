import { strFromU8, unzipSync } from 'fflate';
import { FileReadError, MAX_OUTLINE, type Doc } from './doc';
import { cutParts } from './text';

/** No wanted entry, and no file's wanted entries together, may unpack past this, so a zip bomb cannot fill memory. */
const MAX_UNZIPPED_BYTES = 100 * 1024 * 1024;
const MAX_SHEET_ROWS = 2000;

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function unescapeXml(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] !== '#') return ENTITIES[e.toLowerCase()] ?? m;
    const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
  });
}

/**
 * The wanted entries of a zip, as text. Something that is not a zip is `unreadable`; entries that would unpack
 * past the budget (by the sizes the zip declares) are `tooBig` before any of them is inflated.
 */
function unzipText(data: Uint8Array, want: (name: string) => boolean): Map<string, string> {
  let total = 0;
  try {
    const files = unzipSync(data, {
      filter: (f) => {
        if (!want(f.name)) return false;
        total += f.originalSize;
        if (f.originalSize > MAX_UNZIPPED_BYTES) throw new FileReadError('tooBig', `${f.name} unpacks too large`);
        if (total > MAX_UNZIPPED_BYTES) throw new FileReadError('tooBig', 'the file unpacks too large');
        return true;
      },
    });
    return new Map(Object.entries(files).map(([name, bytes]) => [name, strFromU8(bytes)]));
  } catch (e) {
    if (e instanceof FileReadError) throw e;
    throw new FileReadError('unreadable', `cannot open the file: ${e instanceof Error ? e.message : String(e)}`);
  }
}

function required(files: Map<string, string>, name: string): string {
  const xml = files.get(name);
  if (xml === undefined) throw new FileReadError('unreadable', `${name} is missing`);
  return xml;
}

/** Reads a docx: paragraphs as lines, headings (Title, Heading N) as the outline. */
export function readDocx(name: string, data: Uint8Array): Doc {
  const xml = required(unzipText(data, (n) => n === 'word/document.xml'), 'word/document.xml');
  const lines: string[] = [];
  const outline: string[] = [];
  let line = '';
  let heading = false;
  // Paragraph start and end, its style, text runs, tabs and line breaks; a self-closing <w:p/> holds nothing.
  const token = new RegExp(
    [
      '<w:p(?:\\s[^>/]*)?>',
      '</w:p>',
      '<w:pStyle\\s[^>/]*?w:val="([^"]*)"[^>]*/>',
      '<w:t(?:\\s[^>/]*)?>([^<]*)</w:t>',
      '<w:tab\\s*/>',
      '<w:(?:br|cr)\\b[^>]*/>',
    ].join('|'),
    'g',
  );
  for (const m of xml.matchAll(token)) {
    const tag = m[0];
    if (tag.startsWith('<w:pStyle')) heading = /^(?:Heading\s?\d+|Title)$/i.test(unescapeXml(m[1]));
    else if (tag.startsWith('<w:t>') || tag.startsWith('<w:t ')) line += unescapeXml(m[2]);
    else if (tag.startsWith('<w:tab')) line += '\t';
    else if (tag.startsWith('<w:br') || tag.startsWith('<w:cr')) line += '\n';
    else if (tag === '</w:p>') {
      if (heading && line.trim() && outline.length < MAX_OUTLINE) outline.push(line.trim());
      lines.push(line);
      line = '';
      heading = false;
    } else {
      // A paragraph inside a paragraph (a text box): the outer text so far is its own line.
      if (line) lines.push(line);
      line = '';
      heading = false;
    }
  }
  return { name, kind: 'docx', outline, sections: cutParts(lines.join('\n').trim()) };
}

function paragraphsOf(xml: string): string[] {
  const out: string[] = [];
  for (const p of xml.matchAll(/<a:p\b[^>]*>([\s\S]*?)<\/a:p>/g)) {
    let line = '';
    for (const t of p[1].matchAll(/<a:t(?:\s[^>/]*)?>([^<]*)<\/a:t>|<a:br\b[^>]*\/>/g)) {
      line += t[1] === undefined ? '\n' : unescapeXml(t[1]);
    }
    if (line.trim()) out.push(line);
  }
  return out;
}

/** Slide files in the order the deck shows them (sldIdLst through the rels), or null when that cannot be read. */
function deckOrder(files: Map<string, string>): string[] | null {
  const list = files.get('ppt/presentation.xml');
  const rels = files.get('ppt/_rels/presentation.xml.rels');
  if (!list || !rels) return null;
  const targets = new Map<string, string>();
  for (const r of rels.matchAll(/<Relationship\b[^>]*>/g)) {
    const id = /\bId="([^"]*)"/.exec(r[0])?.[1];
    const target = /\bTarget="([^"]*)"/.exec(r[0])?.[1];
    if (id && target) targets.set(id, target.startsWith('/') ? target.slice(1) : `ppt/${target}`);
  }
  const order = [...list.matchAll(/<p:sldId\b[^>]*>/g)]
    .map((s) => targets.get(/\br:id="([^"]*)"/.exec(s[0])?.[1] ?? '') ?? '')
    .filter((path) => files.has(path));
  return order.length > 0 ? order : null;
}

/** Reads a pptx: one section per slide in deck order (file-number order without a readable deck), title first. */
export function readPptx(name: string, data: Uint8Array): Doc {
  const files = unzipText(data, (n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)
    || n === 'ppt/presentation.xml' || n === 'ppt/_rels/presentation.xml.rels');
  const byNumber = [...files.keys()]
    .filter((n) => n.startsWith('ppt/slides/'))
    .sort((a, b) => Number(/(\d+)\.xml$/.exec(a)?.[1]) - Number(/(\d+)\.xml$/.exec(b)?.[1]));
  const slides = (deckOrder(files) ?? byNumber).map((n) => ({ xml: files.get(n) ?? '' }));
  if (slides.length === 0) throw new FileReadError('unreadable', 'no slides found');
  const outline: string[] = [];
  const sections = slides.map(({ xml }, i) => {
    const lines = paragraphsOf(xml);
    const title = [...xml.matchAll(/<p:sp\b[\s\S]*?<\/p:sp>/g)]
      .find((s) => /<p:ph\b[^>]*type="(?:title|ctrTitle)"/.test(s[0]));
    const titleText = title ? paragraphsOf(title[0]).join(' ') : lines[0] ?? '';
    if (titleText && outline.length < MAX_OUTLINE) outline.push(titleText);
    return { label: `slide ${i + 1}`, text: lines.join('\n') };
  });
  return { name, kind: 'pptx', outline, sections };
}

function columnIndex(ref: string): number {
  let n = 0;
  for (const ch of /^[A-Z]+/i.exec(ref)?.[0] ?? '') n = n * 26 + (ch.toUpperCase().charCodeAt(0) - 64);
  return Math.max(n - 1, 0);
}

function textRuns(xml: string): string {
  return [...xml.matchAll(/<t(?:\s[^>/]*)?>([^<]*)<\/t>/g)].map((t) => unescapeXml(t[1])).join('');
}

function sharedStrings(xml: string | undefined): string[] {
  if (!xml) return [];
  return [...xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map((si) => {
    // Phonetic guides (rPh) would repeat the text; plain runs and rich-text runs are the string.
    const body = si[1].replace(/<rPh\b[\s\S]*?<\/rPh>/g, '');
    return textRuns(body);
  });
}

function sheetRows(xml: string, strings: readonly string[]): string {
  const rows: string[] = [];
  for (const row of xml.matchAll(/<row\b[^>]*?(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    if (rows.length >= MAX_SHEET_ROWS) break;
    const cells: string[] = [];
    for (const c of (row[1] ?? '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = c[1];
      const body = c[2] ?? '';
      const type = /\bt="([^"]*)"/.exec(attrs)?.[1];
      const ref = /\br="([^"]*)"/.exec(attrs)?.[1];
      const v = /<v>([^<]*)<\/v>/.exec(body)?.[1];
      let value = '';
      if (type === 'inlineStr') value = textRuns(body);
      else if (v !== undefined) value = type === 's' ? strings[Number(v)] ?? '' : unescapeXml(v);
      if (type === 'b') value = v === '1' ? 'TRUE' : 'FALSE';
      const at = ref ? columnIndex(ref) : cells.length;
      while (cells.length < at) cells.push('');
      cells[at] = value.replace(/[\t\r\n]+/g, ' ');
    }
    rows.push(cells.join('\t'));
  }
  while (rows.length > 0 && rows[rows.length - 1] === '') rows.pop();
  return rows.join('\n');
}

/** Reads an xlsx: one tab-separated section per sheet, in workbook order. */
export function readXlsx(name: string, data: Uint8Array): Doc {
  const wanted = /^xl\/(?:worksheets\/[^/]+\.xml|sharedStrings\.xml|workbook\.xml|_rels\/workbook\.xml\.rels)$/;
  const files = unzipText(data, (n) => wanted.test(n));
  const workbook = required(files, 'xl/workbook.xml');
  const rels = new Map<string, string>();
  for (const r of (files.get('xl/_rels/workbook.xml.rels') ?? '').matchAll(/<Relationship\b[^>]*>/g)) {
    const id = /\bId="([^"]*)"/.exec(r[0])?.[1];
    const target = /\bTarget="([^"]*)"/.exec(r[0])?.[1];
    if (id && target) rels.set(id, target.startsWith('/') ? target.slice(1) : `xl/${target}`);
  }
  const strings = sharedStrings(files.get('xl/sharedStrings.xml'));
  const sheets = [...workbook.matchAll(/<sheet\b[^>]*>/g)].map((s, i) => ({
    name: unescapeXml(/\bname="([^"]*)"/.exec(s[0])?.[1] ?? `Sheet${i + 1}`),
    path: rels.get(/\br:id="([^"]*)"/.exec(s[0])?.[1] ?? '') ?? `xl/worksheets/sheet${i + 1}.xml`,
  }));
  // A chart sheet has no cells; it has no worksheet file, so it drops out.
  const cells = sheets.filter((s) => files.has(s.path));
  if (cells.length === 0) throw new FileReadError('unreadable', 'no sheets found');
  const sections = cells.map((s) => ({
    label: `sheet ${s.name}`,
    text: sheetRows(required(files, s.path), strings),
  }));
  return { name, kind: 'xlsx', outline: cells.slice(0, MAX_OUTLINE).map((s) => s.name), sections };
}

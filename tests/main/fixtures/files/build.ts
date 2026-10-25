import { strToU8, zipSync } from 'fflate';

const enc = (s: string): Uint8Array => strToU8(s);

/** "中文" in GB18030, written out because Node has no GBK encoder. */
export const GBK_ZHONGWEN = Uint8Array.from([0xd6, 0xd0, 0xce, 0xc4]);

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** A PDF with one page per entry of `pages` (Helvetica text) and an outline entry per page. */
export function buildPdf(pages: string[]): Buffer {
  const n = pages.length;
  const pageId = (i: number): number => 4 + i;
  const contentId = (i: number): number => 4 + n + i;
  const fontId = 4 + 2 * n;
  const outlinesId = fontId + 1;
  const itemId = (i: number): number => outlinesId + 1 + i;
  const objs = new Map<number, string>();
  objs.set(1, `<< /Type /Catalog /Pages 2 0 R /Outlines ${outlinesId} 0 R >>`);
  objs.set(2, `<< /Type /Pages /Kids [${pages.map((_, i) => `${pageId(i)} 0 R`).join(' ')}] /Count ${n} >>`);
  objs.set(3, '<< >>');
  pages.forEach((text, i) => {
    objs.set(pageId(i), `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents ${contentId(i)} 0 R `
      + `/Resources << /Font << /F1 ${fontId} 0 R >> >> >>`);
    const stream = `BT /F1 14 Tf 20 100 Td (${text.replace(/[()\\]/g, '\\$&')}) Tj ET`;
    objs.set(contentId(i), `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  });
  objs.set(fontId, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  objs.set(outlinesId, `<< /Type /Outlines /First ${itemId(0)} 0 R /Last ${itemId(n - 1)} 0 R /Count ${n} >>`);
  pages.forEach((_, i) => {
    const links = (i > 0 ? `/Prev ${itemId(i - 1)} 0 R ` : '') + (i < n - 1 ? `/Next ${itemId(i + 1)} 0 R ` : '');
    objs.set(itemId(i),
      `<< /Title (Chapter ${i + 1}) /Parent ${outlinesId} 0 R ${links}/Dest [${pageId(i)} 0 R /Fit] >>`);
  });
  return serializePdf(objs, itemId(n - 1));
}

/** Writes numbered objects 1..last as a PDF with a correct xref table. */
function serializePdf(objs: Map<number, string>, last: number): Buffer {
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (let id = 1; id <= last; id++) {
    offsets[id] = out.length;
    out += `${id} 0 obj\n${objs.get(id) ?? '<< >>'}\nendobj\n`;
  }
  const xref = out.length;
  out += `xref\n0 ${last + 1}\n0000000000 65535 f \n`;
  for (let id = 1; id <= last; id++) out += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${last + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

/**
 * One page showing "中文" in a font that is not embedded and has no ToUnicode map: only the predefined
 * Adobe CMaps (GBK-EUC-H here, Adobe-GB1) can turn its codes into text.
 */
export function buildCjkPdf(): Buffer {
  const stream = 'BT /F1 14 Tf 20 100 Td <D6D0CEC4> Tj ET';
  const objs = new Map<number, string>([
    [1, '<< /Type /Catalog /Pages 2 0 R >>'],
    [2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>'],
    [3, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R '
      + '/Resources << /Font << /F1 5 0 R >> >> >>'],
    [4, `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`],
    [5, '<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light /Encoding /GBK-EUC-H /DescendantFonts [6 0 R] >>'],
    [6, '<< /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light /DW 1000 /FontDescriptor 7 0 R '
      + '/CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 2 >> >>'],
    [7, '<< /Type /FontDescriptor /FontName /STSong-Light /Flags 6 /FontBBox [-25 -254 1000 880] /ItalicAngle 0 '
      + '/Ascent 880 /Descent -120 /CapHeight 880 /StemV 93 >>'],
  ]);
  return serializePdf(objs, 7);
}

const NS_W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const NS_A = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"';
const NS_P = 'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
const NS_S = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"';
const NS_R = 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';

/** A docx; a paragraph with `heading` set carries a Heading style. */
export function buildDocx(paragraphs: { text: string; heading?: number | 'Title' }[]): Uint8Array {
  const body = paragraphs.map((p) => {
    const style = p.heading === undefined ? ''
      : `<w:pPr><w:pStyle w:val="${p.heading === 'Title' ? 'Title' : `Heading${p.heading}`}"/></w:pPr>`;
    const runs = p.text.split('\t').map((t) => `<w:r><w:t xml:space="preserve">${esc(t)}</w:t></w:r>`)
      .join('<w:r><w:tab/></w:r>');
    return `<w:p>${style}${runs}</w:p>`;
  }).join('');
  return zipSync({
    '[Content_Types].xml': enc(`${HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>`),
    'word/document.xml': enc(`${HEAD}<w:document ${NS_W}><w:body>${body}<w:sectPr/></w:body></w:document>`),
  });
}

/** A pptx with one slide per entry: a title shape and body lines. */
/**
 * `deckOrder` lists slide file numbers in the order presentation.xml shows them; without it the deck has no
 * presentation.xml, as in a file that was stripped down.
 */
export function buildPptx(slides: { title: string; lines: string[] }[], deckOrder?: number[]): Uint8Array {
  const files: Record<string, Uint8Array> = { '[Content_Types].xml': enc(`${HEAD}<Types/>`) };
  slides.forEach((s, i) => {
    const body = s.lines.map((l) => `<a:p><a:r><a:t>${esc(l)}</a:t></a:r></a:p>`).join('');
    files[`ppt/slides/slide${i + 1}.xml`] = enc(`${HEAD}<p:sld ${NS_P} ${NS_A}><p:cSld><p:spTree>`
      + '<p:sp><p:nvSpPr><p:cNvPr id="2" name="Title"/><p:cNvSpPr/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>'
      + `<p:txBody><a:p><a:r><a:t>${esc(s.title)}</a:t></a:r></a:p></p:txBody></p:sp>`
      + '<p:sp><p:nvSpPr><p:cNvPr id="3" name="Body"/><p:cNvSpPr/><p:nvPr><p:ph idx="1"/></p:nvPr></p:nvSpPr>'
      + `<p:txBody>${body}</p:txBody></p:sp></p:spTree></p:cSld></p:sld>`);
  });
  if (deckOrder) {
    files['ppt/presentation.xml'] = enc(`${HEAD}<p:presentation ${NS_P} ${NS_R}><p:sldIdLst>${
      deckOrder.map((n, i) => `<p:sldId id="${256 + i}" r:id="rId${n}"/>`).join('')}</p:sldIdLst></p:presentation>`);
    const rel = (i: number): string =>
      `<Relationship Id="rId${i + 1}" Type="slide" Target="slides/slide${i + 1}.xml"/>`;
    files['ppt/_rels/presentation.xml.rels'] = enc(
      `${HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${
        slides.map((_, i) => rel(i)).join('')}</Relationships>`);
  }
  return zipSync(files);
}

/** An xlsx; strings go through sharedStrings.xml the way Excel writes them, numbers stay inline. */
export function buildXlsx(sheets: { name: string; rows: (string | number)[][] }[]): Uint8Array {
  const shared: string[] = [];
  const files: Record<string, Uint8Array> = {};
  const col = (i: number): string => String.fromCharCode(65 + i);
  sheets.forEach((s, si) => {
    const rows = s.rows.map((row, ri) => {
      const cells = row.map((v, ci) => {
        const ref = `${col(ci)}${ri + 1}`;
        if (typeof v === 'number') return `<c r="${ref}"><v>${v}</v></c>`;
        shared.push(v);
        return `<c r="${ref}" t="s"><v>${shared.length - 1}</v></c>`;
      }).join('');
      return `<row r="${ri + 1}">${cells}</row>`;
    }).join('');
    files[`xl/worksheets/sheet${si + 1}.xml`] = enc(
      `${HEAD}<worksheet ${NS_S}><sheetData>${rows}</sheetData></worksheet>`);
  });
  files['xl/sharedStrings.xml'] = enc(
    `${HEAD}<sst ${NS_S}>${shared.map((t) => `<si><t>${esc(t)}</t></si>`).join('')}</sst>`);
  files['xl/workbook.xml'] = enc(`${HEAD}<workbook ${NS_S} ${NS_R}><sheets>${
    sheets.map((s, i) => `<sheet name="${esc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')
  }</sheets></workbook>`);
  files['xl/_rels/workbook.xml.rels'] = enc(
    `${HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${
      sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="worksheet" Target="worksheets/sheet${i + 1}.xml"/>`)
        .join('')}</Relationships>`);
  files['[Content_Types].xml'] = enc(`${HEAD}<Types/>`);
  return zipSync(files);
}

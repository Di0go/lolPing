import { describe, expect, it } from 'vitest';
import { eventIcs, normalizeTable, tableHtml, tableTsv, TABLE_MAX } from '../../../src/shared/teammate/grab';

describe('normalizeTable', () => {
  it('pads ragged rows and refuses tables over the limits', () => {
    expect(normalizeTable([['a', 'b', 'c'], ['d']])).toEqual([['a', 'b', 'c'], ['d', '', '']]);
    expect(normalizeTable([['a', 1, null]])).toEqual([['a', '1', '']]);
    expect(normalizeTable([])).toBeNull();
    expect(normalizeTable([[]])).toBeNull();
    expect(normalizeTable('a,b')).toBeNull();
    expect(normalizeTable([['a'], 'b'])).toBeNull();
    expect(normalizeTable([[{ x: 1 }]])).toBeNull();
    expect(normalizeTable(Array.from({ length: TABLE_MAX.rows }, () => ['x']))).not.toBeNull();
    expect(normalizeTable(Array.from({ length: TABLE_MAX.rows + 1 }, () => ['x']))).toBeNull();
    expect(normalizeTable([Array.from({ length: TABLE_MAX.cols }, () => 'x')])).not.toBeNull();
    expect(normalizeTable([Array.from({ length: TABLE_MAX.cols + 1 }, () => 'x')])).toBeNull();
  });

  it('cuts a long cell without splitting a surrogate pair', () => {
    const cut = normalizeTable([['a'.repeat(2000)]]);
    expect(cut?.[0][0]).toHaveLength(TABLE_MAX.cell);
    const emoji = normalizeTable([['a'.repeat(TABLE_MAX.cell - 1) + '😀']]);
    expect(emoji?.[0][0]).toBe('a'.repeat(TABLE_MAX.cell - 1));
  });
});

describe('tableTsv', () => {
  it('turns tabs and line breaks inside a cell into spaces in TSV', () => {
    const tsv = tableTsv([['a\tb', 'c\r\nd'], ['e\nf', 'g']]);
    expect(tsv).toBe('a b\tc d\r\ne f\tg\r\n');
  });
});

describe('tableHtml', () => {
  it('uses th for the first row and td for the rest', () => {
    const html = tableHtml([['Name', 'Qty'], ['Tea', '2']]);
    expect(html).toBe('<table><tr><th>Name</th><th>Qty</th></tr><tr><td>Tea</td><td>2</td></tr></table>');
  });

  it('keeps a line break inside the cell in the HTML', () => {
    const html = tableHtml([['h'], ['one\ntwo\r\nthree']]);
    const br = '<br style="mso-data-placement:same-cell">';
    expect(html).toContain(`one${br}two${br}three`);
    expect(html).not.toMatch(/<br>/);
  });

  it('marks only leading-zero and long-digit cells as text', () => {
    const html = tableHtml([['007', '0.5', '1234567890123456', '123456789012345', '12', 'x']]);
    const text = `style="mso-number-format:'\\@'"`;
    expect(html).toContain(`<th ${text}>007</th>`);
    expect(html).toContain('<th>0.5</th>');
    expect(html).toContain(`<th ${text}>1234567890123456</th>`);
    expect(html).toContain('<th>123456789012345</th>');
    expect(html).toContain('<th>12</th>');
    expect(html.match(/mso-number-format/g)).toHaveLength(2);
  });

  it('escapes HTML in cells', () => {
    const html = tableHtml([['<b>&"x"\'']]);
    expect(html).toContain('&lt;b&gt;&amp;&quot;x&quot;&#39;');
    expect(html).not.toContain('<b>');
  });
});

describe('eventIcs', () => {
  const base = { uid: 'u1@lolping', now: Date.UTC(2026, 9, 21, 12, 0, 0), zoneOffset: () => -240 };
  const lines = (ics: string | null): string[] => (ics ?? '').split('\r\n');

  it('writes start and end in UTC from local wall time', () => {
    const ics = eventIcs({ title: 'Dentist', start: '2026-10-22T15:00', end: '2026-10-22T16:30' }, base);
    expect(ics).not.toBeNull();
    const l = lines(ics);
    expect(l.slice(0, 5)).toEqual([
      'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//lolPing//teammate//EN', 'METHOD:PUBLISH', 'BEGIN:VEVENT',
    ]);
    expect(l).toContain('UID:u1@lolping');
    expect(l).toContain('DTSTAMP:20261021T120000Z');
    expect(l).toContain('DTSTART:20261022T190000Z');
    expect(l).toContain('DTEND:20261022T203000Z');
    expect(l).toContain('SUMMARY:Dentist');
    expect(l.slice(-3)).toEqual(['END:VEVENT', 'END:VCALENDAR', '']);
    expect(l.some((x) => x.startsWith('LOCATION') || x.startsWith('DESCRIPTION'))).toBe(false);
  });

  it('asks for the offset of the date it converts', () => {
    const seen: number[] = [];
    const zoneOffset = (d: Date): number => {
      seen.push(d.getTime());
      return -240;
    };
    eventIcs({ title: 't', start: '2026-10-22T15:00' }, { ...base, zoneOffset });
    expect(seen.length).toBeGreaterThan(0);
    for (const t of seen) expect(Math.abs(t - Date.UTC(2026, 9, 22, 17, 0))).toBeLessThan(24 * 3600 * 1000);
  });

  it('defaults the end to one hour later, or the next day for an all-day event', () => {
    const timed = lines(eventIcs({ title: 'a', start: '2026-12-31T23:30' }, { ...base, zoneOffset: () => 0 }));
    expect(timed).toContain('DTSTART:20261231T233000Z');
    expect(timed).toContain('DTEND:20270101T003000Z');
    const day = lines(eventIcs({ title: 'a', start: '2026-02-28' }, base));
    expect(day).toContain('DTSTART;VALUE=DATE:20260228');
    expect(day).toContain('DTEND;VALUE=DATE:20260301');
  });

  it('treats an all-day end as the last day of the event', () => {
    const day = lines(eventIcs({ title: 'a', start: '2026-03-03', end: '2026-03-05' }, base));
    expect(day).toContain('DTEND;VALUE=DATE:20260306');
  });

  it('escapes text and writes location and notes', () => {
    const e = { title: 'a;b,c\\d', start: '2026-10-22T15:00', location: 'Room 1, Hall', notes: 'x\ny\r\nz' };
    const l = lines(eventIcs(e, base));
    expect(l).toContain('SUMMARY:a\\;b\\,c\\\\d');
    expect(l).toContain('LOCATION:Room 1\\, Hall');
    expect(l).toContain('DESCRIPTION:x\\ny\\nz');
  });

  it('escapes and folds long Chinese text on character boundaries', () => {
    const notes = '会议内容，请带上资料；'.repeat(20);
    const l = lines(eventIcs({ title: 'a', start: '2026-10-22T15:00', notes }, base));
    const encoder = new TextEncoder();
    for (const line of l) expect(encoder.encode(line).length).toBeLessThanOrEqual(75);
    const start = l.findIndex((x) => x.startsWith('DESCRIPTION:'));
    let end = start + 1;
    while (l[end]?.startsWith(' ')) end++;
    expect(end).toBeGreaterThan(start + 1);
    const joined = l.slice(start, end).map((x, i) => (i === 0 ? x : x.slice(1))).join('');
    expect(joined).toBe(`DESCRIPTION:${notes.replace(/[,;]/g, (c) => `\\${c}`)}`);
    expect(joined).not.toContain('�');
  });

  it('refuses a start that is not a date', () => {
    expect(eventIcs({ title: 'a', start: 'tomorrow' }, base)).toBeNull();
    expect(eventIcs({ title: 'a', start: '2026-02-30' }, base)).toBeNull();
    expect(eventIcs({ title: 'a', start: '2026-10-22T25:00' }, base)).toBeNull();
    expect(eventIcs({ title: 'a', start: '' }, base)).toBeNull();
  });

  it('refuses a missing title, a bad end, an end before the start, or a mix of date and time', () => {
    expect(eventIcs({ title: '  ', start: '2026-10-22' }, base)).toBeNull();
    expect(eventIcs({ title: 'a', start: '2026-10-22T15:00', end: 'later' }, base)).toBeNull();
    expect(eventIcs({ title: 'a', start: '2026-10-22T15:00', end: '2026-10-22T14:00' }, base)).toBeNull();
    expect(eventIcs({ title: 'a', start: '2026-10-22', end: '2026-10-21' }, base)).toBeNull();
    expect(eventIcs({ title: 'a', start: '2026-10-22', end: '2026-10-22T15:00' }, base)).toBeNull();
  });
});

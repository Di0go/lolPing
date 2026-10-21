export const TABLE_MAX = { rows: 50, cols: 20, cell: 1000 };

function cellText(value: unknown): string | null {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return null;
}

function cutCell(text: string): string {
  if (text.length <= TABLE_MAX.cell) return text;
  const cut = text.slice(0, TABLE_MAX.cell);
  // Never leave half of a surrogate pair at the end.
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
}

/** Rows padded to the widest row; cells cut to TABLE_MAX.cell; null when empty or over the limits. */
export function normalizeTable(rows: unknown): string[][] | null {
  if (!Array.isArray(rows) || rows.length === 0 || rows.length > TABLE_MAX.rows) return null;
  const table: string[][] = [];
  let width = 0;
  for (const row of rows as unknown[]) {
    if (!Array.isArray(row) || row.length > TABLE_MAX.cols) return null;
    const cells: string[] = [];
    for (const value of row as unknown[]) {
      const text = cellText(value);
      if (text === null) return null;
      cells.push(cutCell(text));
    }
    width = Math.max(width, cells.length);
    table.push(cells);
  }
  if (width === 0) return null;
  return table.map((cells) => [...cells, ...Array<string>(width - cells.length).fill('')]);
}

/** Tabs and line breaks inside a cell become one space. Rows end with \r\n. */
export function tableTsv(rows: string[][]): string {
  return rows.map((row) => `${row.map((c) => c.replace(/[\t\r\n]+/g, ' ')).join('\t')}\r\n`).join('');
}

const SAME_CELL_BREAK = '<br style="mso-data-placement:same-cell">';
// Without this Excel reads 007 as 7 and long digit strings in scientific notation; on every cell it would turn
// real numbers into text, so only these cells get it.
const AS_TEXT = ` style="mso-number-format:'\\@'"`;

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function htmlCell(tag: 'th' | 'td', cell: string): string {
  const asText = /^0\d/.test(cell) || /^\d{16,}$/.test(cell);
  // A plain <br> starts a new row in Excel and merges the row's other cells.
  const body = escapeHtml(cell).replace(/\r\n|\r|\n/g, SAME_CELL_BREAK);
  return `<${tag}${asText ? AS_TEXT : ''}>${body}</${tag}>`;
}

/** <table> with <th> for the first row; text escaped; a line break as <br style="mso-data-placement:same-cell">;
 *  style="mso-number-format:'\@'" only on cells with a leading zero (0\d) or 16+ digits. */
export function tableHtml(rows: string[][]): string {
  const body = rows
    .map((row, i) => `<tr>${row.map((c) => htmlCell(i === 0 ? 'th' : 'td', c)).join('')}</tr>`)
    .join('');
  return `<table>${body}</table>`;
}

export interface EventFields {
  title: string;
  start: string;
  end?: string;
  location?: string;
  notes?: string;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WHEN = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?$/;

interface When {
  /** The wall-clock fields read as if they were UTC. */
  wall: number;
  allDay: boolean;
}

function parseWhen(text: string): When | null {
  const m = WHEN.exec(text);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const allDay = m[4] === undefined;
  const [h, mi] = allDay ? [0, 0] : [Number(m[4]), Number(m[5])];
  const wall = Date.UTC(y, mo - 1, d, h, mi);
  const back = new Date(wall);
  // Date.UTC rolls 02-30 over to March; a round trip catches that.
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return null;
  if (back.getUTCHours() !== h || back.getUTCMinutes() !== mi) return null;
  return { wall, allDay };
}

const pad = (n: number, len = 2): string => String(n).padStart(len, '0');

function utcStamp(ms: number): string {
  const d = new Date(ms);
  const date = `${pad(d.getUTCFullYear(), 4)}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
  return `${date}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
}

function dateStamp(ms: number): string {
  return utcStamp(ms).slice(0, 8);
}

/** Wall time to UTC. Asks twice so a date near a daylight-saving change gets the offset in force at that instant. */
function wallToUtc(wall: number, zoneOffset: (d: Date) => number): number {
  const first = wall - zoneOffset(new Date(wall)) * MINUTE;
  return wall - zoneOffset(new Date(first)) * MINUTE;
}

function escapeText(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r\n|\r|\n/g, '\\n');
}

const FOLD_OCTETS = 75;
const encoder = new TextEncoder();

/** RFC 5545 folding: lines of at most 75 UTF-8 bytes, continuations led by one space, no character split. */
function fold(line: string): string[] {
  const out: string[] = [];
  let current = '';
  let used = 0;
  for (const ch of line) {
    const size = encoder.encode(ch).length;
    if (used + size > FOLD_OCTETS) {
      out.push(current);
      current = ' ';
      used = 1;
    }
    current += ch;
    used += size;
  }
  out.push(current);
  return out;
}

/** start/end are local wall times "YYYY-MM-DDTHH:mm" (or a date "YYYY-MM-DD" for all day); `zoneOffset` gives the
 *  local offset in minutes for a date (injected, so tests don't depend on the machine). null when invalid.
 *  `zoneOffset` is local time minus UTC in minutes (-240 for US Eastern summer time, so 15:00 local is 19:00Z);
 *  the app passes `(d) => -d.getTimezoneOffset()`. An all-day `end` is the last day of the event. */
export function eventIcs(
  e: EventFields,
  opts: { uid: string; now: number; zoneOffset: (d: Date) => number },
): string | null {
  if (e.title.trim() === '') return null;
  const start = parseWhen(e.start);
  if (!start) return null;
  let end: When | null = null;
  if (e.end !== undefined && e.end !== '') {
    end = parseWhen(e.end);
    if (!end || end.allDay !== start.allDay || end.wall < start.wall) return null;
  }

  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//lolPing//teammate//EN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${opts.uid}`,
    `DTSTAMP:${utcStamp(opts.now)}`,
  ];
  if (start.allDay) {
    lines.push(`DTSTART;VALUE=DATE:${dateStamp(start.wall)}`);
    lines.push(`DTEND;VALUE=DATE:${dateStamp((end ?? start).wall + DAY)}`);
  } else {
    const from = wallToUtc(start.wall, opts.zoneOffset);
    lines.push(`DTSTART:${utcStamp(from)}`);
    lines.push(`DTEND:${utcStamp(end ? wallToUtc(end.wall, opts.zoneOffset) : from + HOUR)}`);
  }
  lines.push(`SUMMARY:${escapeText(e.title)}`);
  if (e.location) lines.push(`LOCATION:${escapeText(e.location)}`);
  if (e.notes) lines.push(`DESCRIPTION:${escapeText(e.notes)}`);
  lines.push('END:VEVENT', 'END:VCALENDAR');
  return `${lines.flatMap(fold).join('\r\n')}\r\n`;
}

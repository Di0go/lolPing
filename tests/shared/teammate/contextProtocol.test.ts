import { describe, expect, it } from 'vitest';
import {
  captureCommand, parseContextLine, parseFieldsFile, pasteCommand, readCommand, setFieldCommand,
} from '../../../src/shared/teammate/contextProtocol';

/** A read reply with every layer off; `over` adds or replaces fields. */
const readLine = (over: Record<string, unknown> = {}): string => JSON.stringify({
  type: 'read', id: 'r1', marks: 'off', marksPath: '', count: 0, text: 'off', file: 'off', boxes: 'off', fields: 'off',
  ...over,
});
/** One line of the helper's fields file; `over` adds or replaces fields. */
const fieldLine = (over: Record<string, unknown> = {}): string => JSON.stringify({
  id: '42.7.1', kind: 'text', label: 'Name', group: '', value: '', secure: false, required: false, options: [], ...over,
});
const textFields = {
  text: 'ok', selection: 'picked', spotTexts: 'one', focusKind: 'field', focusLabel: 'Name', focusValue: 'Ada',
  focusSecure: false, address: 'https://example.com/',
};

describe('contextProtocol', () => {
  it('flattens a capture into the helper\'s strings with whole pixels', () => {
    expect(captureCommand('r1', { display: { x: -1920, y: 0, w: 1920, h: 1080 }, spots: [{ x: 10.6, y: 20 }], dir: 'C:\\t' }))
      .toEqual({
        type: 'capture', id: 'r1', display: '-1920,0,1920,1080', spots: '11,20', overview: 1600, zoom: '1000,750', quality: 80,
        dir: 'C:\\t',
      });
  });

  it('sends the overview area and one crop per spot when given', () => {
    const cmd = captureCommand('r1', {
      display: { x: 0, y: 0, w: 2752, h: 1152 }, area: { x: 92.4, y: 40, w: 1400, h: 1000 },
      spots: [{ x: 700, y: 400 }], crops: [{ x: 264, y: 184, w: 972, h: 432 }], dir: 'C:\\t',
    });
    expect(cmd).toMatchObject({ area: '92,40,1400,1000', crops: '264,184,972,432' });
  });

  it('pairs each zoom path with its rect', () => {
    const line = JSON.stringify({
      type: 'captured', id: 'r1', overview: 'o.jpg', ow: 1600, oh: 900,
      zooms: 'a.jpg;b.jpg', zoomRects: '0,0,1000,750;-1000,330,1000,750',
    });
    expect(parseContextLine(line)).toEqual({
      type: 'captured', id: 'r1', overview: 'o.jpg', ow: 1600, oh: 900,
      zooms: [
        { path: 'a.jpg', rect: { x: 0, y: 0, w: 1000, h: 750 } },
        { path: 'b.jpg', rect: { x: -1000, y: 330, w: 1000, h: 750 } },
      ],
    });
    const none = { type: 'captured', id: 'r1', overview: 'o.jpg', ow: 1, oh: 1, zooms: '', zoomRects: '' };
    expect(parseContextLine(JSON.stringify(none))).toMatchObject({ zooms: [] });
  });

  it('rejects malformed replies', () => {
    const captured = {
      type: 'captured', id: 'r1', overview: 'o.jpg', ow: 1600, oh: 900, zooms: 'a.jpg', zoomRects: '0,0,1000,750',
    };
    expect(parseContextLine('not json')).toBeNull();
    expect(parseContextLine(JSON.stringify([1]))).toBeNull();
    expect(parseContextLine(JSON.stringify({ ...captured, zoomRects: '' }))).toBeNull(); // a path without a rect
    expect(parseContextLine(JSON.stringify({ ...captured, zoomRects: '0,0,1000' }))).toBeNull();
    expect(parseContextLine(JSON.stringify({ ...captured, ow: 0 }))).toBeNull();
    expect(parseContextLine(JSON.stringify({ ...captured, overview: '' }))).toBeNull();
    expect(parseContextLine(JSON.stringify({ type: 'error', id: 'r1', code: 'weird', message: 'x' }))).toBeNull();
    expect(parseContextLine(JSON.stringify({ type: 'error', id: 'r1', code: 'slow', message: 'x' }))).toBeNull();
    expect(parseContextLine(JSON.stringify({ type: 'foreground', id: 'r1', app: 3, title: '' }))).toBeNull();
  });

  it('reads errors, foreground and pong', () => {
    expect(parseContextLine(JSON.stringify({ type: 'error', id: '', code: 'bad', message: 'no id' })))
      .toEqual({ type: 'error', id: '', code: 'bad', message: 'no id' });
    expect(parseContextLine(JSON.stringify({ type: 'foreground', id: 'r2', app: 'Code', title: 'a.ts', window: '263544' })))
      .toEqual({ type: 'foreground', id: 'r2', app: 'Code', title: 'a.ts', window: '263544' });
    expect(parseContextLine(JSON.stringify({ type: 'foreground', id: 'r2', app: 'Code', title: 'a.ts', window: '' })))
      .toMatchObject({ window: '' });
    const noWindow = { type: 'foreground', id: 'r2', app: 'Code', title: 'a.ts' };
    expect(parseContextLine(JSON.stringify(noWindow))).toBeNull();
    expect(parseContextLine(JSON.stringify({ ...noWindow, window: '12x' }))).toBeNull();
    expect(parseContextLine(JSON.stringify({ type: 'pong', id: 'r3' }))).toEqual({ type: 'pong', id: 'r3' });
  });

  it('flattens a read command', () => {
    expect(readCommand('r1', {
      spots: [{ x: 10.4, y: -20 }, { x: 3, y: 4 }], radius: 600, marks: true, text: false, file: true, boxes: true,
      fields: true, dir: 'C:\\t',
    })).toEqual({
      type: 'read', id: 'r1', spots: '10,-20;3,4', radius: 600, marks: true, text: false, file: true, boxes: true,
      fields: true, dir: 'C:\\t',
    });
  });

  it('parses a read reply layer by layer', () => {
    expect(parseContextLine(readLine({
      marks: 'ok', marksPath: 'C:\\t\\marks-r1.tsv', count: 12, ...textFields,
      file: 'ok', filePath: 'C:\\a.pdf', fileAddress: '', how: 'title',
      boxes: 'ok', boxRects: '10,10,40,20|0,0,800,600;',
    }))).toEqual({
      type: 'read', id: 'r1',
      status: { marks: 'ok', text: 'ok', file: 'ok', boxes: 'ok', fields: 'off' },
      marks: { path: 'C:\\t\\marks-r1.tsv', count: 12 },
      text: {
        selection: 'picked', spotTexts: ['one'], focus: { kind: 'field', label: 'Name', value: 'Ada', secure: false },
        address: 'https://example.com/',
      },
      file: { path: 'C:\\a.pdf', address: '', how: 'title' },
      // The second spot has no boxes.
      boxes: [[{ x: 10, y: 10, w: 40, h: 20 }, { x: 0, y: 0, w: 800, h: 600 }], []],
      fields: null,
    });
    // A layer that is off, too slow or refused comes back null with its status.
    expect(parseContextLine(readLine({ text: 'permission', file: 'slow' }))).toEqual({
      type: 'read', id: 'r1', status: { marks: 'off', text: 'permission', file: 'slow', boxes: 'off', fields: 'off' },
      marks: null, text: null, file: null, boxes: null, fields: null,
    });
    expect(parseContextLine(readLine({ text: 'ok', selection: '', spotTexts: '', focusKind: '', focusLabel: '',
      focusValue: '', focusSecure: false, address: '' }))).toMatchObject({
      text: { selection: '', spotTexts: [], focus: null, address: '' },
    });
  });

  it('rejects a read reply with a bad status or a missing layer', () => {
    expect(parseContextLine(readLine({ marks: 'maybe' }))).toBeNull();
    expect(parseContextLine(readLine({ marks: 'ok', marksPath: '', count: 1 }))).toBeNull();
    expect(parseContextLine(readLine({ marks: 'ok', marksPath: 'a.tsv', count: -1 }))).toBeNull();
    expect(parseContextLine(readLine({ text: 'ok' }))).toBeNull(); // ok, but no text fields
    expect(parseContextLine(readLine({ boxes: 'ok' }))).toBeNull();
    expect(parseContextLine(readLine({ fields: 'ok' }))).toBeNull(); // ok, but no file
    expect(parseContextLine(readLine({ fields: 'ok', fieldsPath: 'a.jsonl', fieldCount: -1 }))).toBeNull();
    expect(parseContextLine(readLine({ fields: 'maybe' }))).toBeNull();
    const { fields: _dropped, ...noFields } = JSON.parse(readLine()) as Record<string, unknown>;
    expect(parseContextLine(JSON.stringify(noFields))).toBeNull();
    expect(parseContextLine(readLine({ boxes: 'ok', boxRects: '1,2,3|4,5,6,7' }))).toBeNull();
    expect(parseContextLine(readLine({ file: 'ok', filePath: 'a', fileAddress: '', how: 'guess' }))).toBeNull();
    expect(parseContextLine(readLine({ file: 'ok', filePath: 3, fileAddress: '', how: 'none' }))).toBeNull();
    expect(parseContextLine(readLine({ file: 'ok', filePath: '', fileAddress: '', how: 'none' })))
      .toMatchObject({ file: { path: '', address: '', how: 'none' } });
  });

  it('blanks the value of a secure field', () => {
    const reply = parseContextLine(readLine({
      ...textFields, focusLabel: 'Password', focusValue: 'hunter2', focusSecure: true,
    }));
    expect(reply).toMatchObject({ text: { focus: { kind: 'field', label: 'Password', value: '', secure: true } } });
    expect(JSON.stringify(reply)).not.toContain('hunter2');
    expect(parseContextLine(readLine({ ...textFields, focusSecure: 'true' }))).toBeNull();
    const { focusSecure: _dropped, ...noFlag } = textFields;
    expect(parseContextLine(readLine(noFlag))).toBeNull();
  });

  it('cuts the helper\'s text to its caps in code points, whatever the helper sent', () => {
    const han = '\u{20000}'; // one code point, two UTF-16 units
    const reply = parseContextLine(readLine({
      ...textFields, selection: han.repeat(4_001), spotTexts: `${'a'.repeat(2_001)}\u001eshort`,
      focusValue: 'v'.repeat(2_001), address: `https://example.com/${'p'.repeat(2_000)}`,
    }));
    if (reply?.type !== 'read' || !reply.text) throw new Error('not parsed');
    const { text } = reply;
    expect(text.selection).toBe(han.repeat(4_000));
    expect(text.spotTexts.map((t) => t.length)).toEqual([2_000, 5]);
    expect(text.focus?.value).toHaveLength(2_000);
    expect([...text.address]).toHaveLength(2_000);
  });

  it('parses the fields layer', () => {
    const reply = parseContextLine(readLine({ fields: 'ok', fieldsPath: 'C:\\t\\fields-r1.jsonl', fieldCount: 2 }));
    expect(reply).toMatchObject({
      status: { fields: 'ok' }, fields: { path: 'C:\\t\\fields-r1.jsonl', count: 2 },
    });
    const file = [
      fieldLine({ id: '42.7.1', label: 'Customer name', value: 'Ada', required: true }),
      fieldLine({ id: '42.7.2', kind: 'combo', label: 'Size', options: ['Small', 'Large'], value: 'Small' }),
      fieldLine({ id: '42.7.3', kind: 'radio', label: 'Medium', group: 'Pizza Size', value: 'off' }),
    ].join('\n');
    expect(parseFieldsFile(`${file}\n`)).toEqual([
      {
        id: '42.7.1', kind: 'text', label: 'Customer name', group: '', value: 'Ada', secure: false, required: true,
        options: [],
      },
      {
        id: '42.7.2', kind: 'combo', label: 'Size', group: '', value: 'Small', secure: false, required: false,
        options: ['Small', 'Large'],
      },
      {
        id: '42.7.3', kind: 'radio', label: 'Medium', group: 'Pizza Size', value: 'off', secure: false,
        required: false, options: [],
      },
    ]);
    // A layer that is slow or refused has no file.
    expect(parseContextLine(readLine({ fields: 'slow' }))).toMatchObject({ status: { fields: 'slow' }, fields: null });
  });

  it('skips a fields line that is not a field and keeps the rest', () => {
    const file = [
      'not json', '', '[1]', fieldLine({ id: '' }), fieldLine({ kind: 'slider' }), fieldLine({ secure: 'yes' }),
      fieldLine({ options: [3] }), fieldLine({ id: 'ok.1' }), fieldLine({ id: 'ok.1', label: 'Again' }),
      fieldLine({ id: 'ok.2' }),
    ].join('\n');
    expect(parseFieldsFile(file).map((f) => [f.id, f.label])).toEqual([['ok.1', 'Name'], ['ok.2', 'Name']]);
  });

  it('blanks a secure field value whatever the helper sends', () => {
    const file = fieldLine({ id: '9.1', label: 'Password', value: 'hunter2', secure: true });
    const fields = parseFieldsFile(file);
    expect(fields).toHaveLength(1);
    expect(fields[0]).toMatchObject({ label: 'Password', value: '', secure: true });
    expect(JSON.stringify(fields)).not.toContain('hunter2');
  });

  it('blanks the value of a never-fill label even when the helper sent it', () => {
    const [card, id, name] = parseFieldsFile([
      fieldLine({ id: '1.1', label: 'Card number', value: '4111111111111111' }),
      fieldLine({ id: '1.2', label: '身份证号', value: '110101199001011234' }),
      fieldLine({ id: '1.3', label: 'Full name', value: 'Ada' }),
    ].join('\n'));
    expect([card.value, id.value, name.value]).toEqual(['', '', 'Ada']);
  });

  it('cuts the fields file to its caps in code points, whatever the helper sent', () => {
    const han = '\u{20000}'; // one code point, two UTF-16 units
    const long = fieldLine({
      id: '1.1', label: han.repeat(121), group: han.repeat(121), value: han.repeat(2_001),
      options: Array.from({ length: 51 }, () => han.repeat(121)),
    });
    const [field] = parseFieldsFile(long);
    expect(field.label).toBe(han.repeat(120));
    expect(field.group).toBe(han.repeat(120));
    expect(field.value).toBe(han.repeat(2_000));
    expect(field.options).toHaveLength(50);
    expect(field.options.every((o) => o === han.repeat(120))).toBe(true);
    const many = Array.from({ length: 70 }, (_, i) => fieldLine({ id: `1.${i}` })).join('\n');
    expect(parseFieldsFile(many)).toHaveLength(60);
  });

  it('splits spot texts on the record separator', () => {
    const reply = parseContextLine(readLine({ ...textFields, spotTexts: 'first line\u001esecond, with\ttab\u001e' }));
    expect(reply).toMatchObject({ text: { spotTexts: ['first line', 'second, with\ttab', ''] } });
  });

  it('flattens a paste command', () => {
    expect(pasteCommand('r1', {
      window: '263544', text: 'line one\nline two', click: { x: 10.6, y: -20 }, mode: 'insert', asked: '',
    })).toEqual({
      type: 'paste', id: 'r1', window: '263544', text: 'line one\nline two', click: '11,-20', mode: 'insert', asked: '',
    });
    expect(pasteCommand('r2', { window: '1', text: 'better', click: null, mode: 'replace', asked: 'old' }))
      .toMatchObject({ click: '', mode: 'replace', asked: 'old' });
  });

  it('flattens a setField command', () => {
    expect(setFieldCommand('r1', { window: '263544', field: '42.7.1', value: 'on' }))
      .toEqual({ type: 'setField', id: 'r1', window: '263544', field: '42.7.1', value: 'on' });
  });

  it('leaves out the control characters the helper cannot read, and keeps tabs and line breaks', () => {
    const cmd = pasteCommand('r1', {
      window: '1', text: 'a\u0000b\u0008c\u000cd\u001fe\tf\r\ng\ud800h\u{1F600}', click: null, mode: 'replace',
      asked: 'x\u0007y',
    });
    expect(cmd).toMatchObject({ text: 'abcde\tf\r\ngh\u{1F600}', asked: 'xy' });
    expect(setFieldCommand('r1', { window: '1', field: '1', value: 'A\u0001da' })).toMatchObject({ value: 'Ada' });
  });

  it('parses each paste result', () => {
    for (const result of ['ok', 'hung', 'window', 'hands', 'selection', 'secure', 'busy']) {
      expect(parseContextLine(JSON.stringify({ type: 'pasted', id: 'r1', result })))
        .toEqual({ type: 'pasted', id: 'r1', result });
    }
    expect(parseContextLine(JSON.stringify({ type: 'pasted', id: 'r1', result: 'gone' }))).toBeNull();
    expect(parseContextLine(JSON.stringify({ type: 'pasted', id: 'r1' }))).toBeNull();
  });

  it('parses each setField result', () => {
    for (const result of ['ok', 'gone', 'refused', 'secure', 'window', 'hung']) {
      expect(parseContextLine(JSON.stringify({ type: 'set', id: 'r1', result })))
        .toEqual({ type: 'set', id: 'r1', result });
    }
    expect(parseContextLine(JSON.stringify({ type: 'set', id: 'r1', result: 'busy' }))).toBeNull();
    expect(parseContextLine(JSON.stringify({ type: 'set', id: 'r1', result: 3 }))).toBeNull();
  });
});

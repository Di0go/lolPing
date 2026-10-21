import { describe, expect, it } from 'vitest';
import { captureCommand, parseContextLine, readCommand } from '../../../src/shared/teammate/contextProtocol';

/** A read reply with every layer off; `over` adds or replaces fields. */
const readLine = (over: Record<string, unknown> = {}): string => JSON.stringify({
  type: 'read', id: 'r1', marks: 'off', marksPath: '', count: 0, text: 'off', file: 'off', boxes: 'off', ...over,
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
    expect(parseContextLine(JSON.stringify({ type: 'foreground', id: 'r2', app: 'Code', title: 'a.ts' })))
      .toEqual({ type: 'foreground', id: 'r2', app: 'Code', title: 'a.ts' });
    expect(parseContextLine(JSON.stringify({ type: 'pong', id: 'r3' }))).toEqual({ type: 'pong', id: 'r3' });
  });

  it('flattens a read command', () => {
    expect(readCommand('r1', {
      spots: [{ x: 10.4, y: -20 }, { x: 3, y: 4 }], radius: 600, marks: true, text: false, file: true, boxes: true,
      dir: 'C:\\t',
    })).toEqual({
      type: 'read', id: 'r1', spots: '10,-20;3,4', radius: 600, marks: true, text: false, file: true, boxes: true,
      dir: 'C:\\t',
    });
  });

  it('parses a read reply layer by layer', () => {
    expect(parseContextLine(readLine({
      marks: 'ok', marksPath: 'C:\\t\\marks-r1.tsv', count: 12, ...textFields,
      file: 'ok', filePath: 'C:\\a.pdf', fileAddress: '', how: 'title',
      boxes: 'ok', boxRects: '10,10,40,20|0,0,800,600;',
    }))).toEqual({
      type: 'read', id: 'r1',
      status: { marks: 'ok', text: 'ok', file: 'ok', boxes: 'ok' },
      marks: { path: 'C:\\t\\marks-r1.tsv', count: 12 },
      text: {
        selection: 'picked', spotTexts: ['one'], focus: { kind: 'field', label: 'Name', value: 'Ada', secure: false },
        address: 'https://example.com/',
      },
      file: { path: 'C:\\a.pdf', address: '', how: 'title' },
      // The second spot has no boxes.
      boxes: [[{ x: 10, y: 10, w: 40, h: 20 }, { x: 0, y: 0, w: 800, h: 600 }], []],
    });
    // A layer that is off, too slow or refused comes back null with its status.
    expect(parseContextLine(readLine({ text: 'permission', file: 'slow' }))).toEqual({
      type: 'read', id: 'r1', status: { marks: 'off', text: 'permission', file: 'slow', boxes: 'off' }, marks: null,
      text: null, file: null, boxes: null,
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

  it('splits spot texts on the record separator', () => {
    const reply = parseContextLine(readLine({ ...textFields, spotTexts: 'first line\u001esecond, with\ttab\u001e' }));
    expect(reply).toMatchObject({ text: { spotTexts: ['first line', 'second, with\ttab', ''] } });
  });
});

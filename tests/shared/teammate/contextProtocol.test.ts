import { describe, expect, it } from 'vitest';
import {
  captureCommand, fileOfCommand, marksCommand, parseContextLine, systemTextCommand,
} from '../../../src/shared/teammate/contextProtocol';

describe('contextProtocol', () => {
  it('flattens a capture into the helper\'s strings with whole pixels', () => {
    expect(captureCommand('r1', { display: { x: -1920, y: 0, w: 1920, h: 1080 }, spots: [{ x: 10.6, y: 20 }], dir: 'C:\\t' }))
      .toEqual({
        type: 'capture', id: 'r1', display: '-1920,0,1920,1080', spots: '11,20', overview: 1600, zoom: '1000,750', quality: 80,
        dir: 'C:\\t',
      });
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
    expect(parseContextLine(JSON.stringify({ type: 'foreground', id: 'r1', app: 3, title: '' }))).toBeNull();
  });

  it('reads errors, foreground and pong', () => {
    expect(parseContextLine(JSON.stringify({ type: 'error', id: '', code: 'bad', message: 'no id' })))
      .toEqual({ type: 'error', id: '', code: 'bad', message: 'no id' });
    expect(parseContextLine(JSON.stringify({ type: 'foreground', id: 'r2', app: 'Code', title: 'a.ts' })))
      .toEqual({ type: 'foreground', id: 'r2', app: 'Code', title: 'a.ts' });
    expect(parseContextLine(JSON.stringify({ type: 'pong', id: 'r3' }))).toEqual({ type: 'pong', id: 'r3' });
  });

  it('flattens marks, systemText and fileOf commands', () => {
    expect(marksCommand('m1', {
      of: 'r1', spots: [{ x: 10.4, y: -20 }, { x: 3, y: 4 }], radius: 600, ocr: true, controls: false, dir: 'C:\\t',
    })).toEqual({
      type: 'marks', id: 'm1', of: 'r1', spots: '10,-20;3,4', radius: 600, ocr: true, controls: false, dir: 'C:\\t',
    });
    expect(systemTextCommand('s1', [{ x: 1, y: 2 }])).toEqual({ type: 'systemText', id: 's1', spots: '1,2' });
    expect(fileOfCommand('f1')).toEqual({ type: 'fileOf', id: 'f1' });
  });

  it('parses marks, systemText and fileOf replies', () => {
    expect(parseContextLine(JSON.stringify({ type: 'marks', id: 'm1', path: 'C:\\t\\marks-m1.tsv', count: 12 })))
      .toEqual({ type: 'marks', id: 'm1', path: 'C:\\t\\marks-m1.tsv', count: 12, exiting: false });
    // A probe ran over its budget: the marks the others found, and the helper exits after them.
    expect(parseContextLine(JSON.stringify({ type: 'marks', id: 'm2', path: 'm.tsv', count: 3, exiting: true })))
      .toEqual({ type: 'marks', id: 'm2', path: 'm.tsv', count: 3, exiting: true });
    expect(parseContextLine(JSON.stringify({ type: 'marks', id: 'm2', path: 'm.tsv', count: 3, exiting: 'yes' })))
      .toBeNull();
    expect(parseContextLine(JSON.stringify({
      type: 'systemText', id: 's1', selection: 'picked', spotTexts: 'one', focusKind: 'field', focusLabel: 'Name',
      focusValue: 'Ada', focusSecure: false, address: 'https://example.com/',
    }))).toEqual({
      type: 'systemText', id: 's1',
      layer: {
        selection: 'picked', spotTexts: ['one'], focus: { kind: 'field', label: 'Name', value: 'Ada', secure: false },
        address: 'https://example.com/',
      },
    });
    expect(parseContextLine(JSON.stringify({
      type: 'systemText', id: 's2', selection: '', spotTexts: '', focusKind: '', focusLabel: '', focusValue: '',
      focusSecure: false, address: '',
    }))).toEqual({ type: 'systemText', id: 's2', layer: { selection: '', spotTexts: [], focus: null, address: '' } });
    expect(parseContextLine(JSON.stringify({ type: 'fileOf', id: 'f1', path: 'C:\\a.pdf', address: '', how: 'title' })))
      .toEqual({ type: 'fileOf', id: 'f1', path: 'C:\\a.pdf', address: '', how: 'title' });
    expect(parseContextLine(JSON.stringify({ type: 'error', id: 'f1', code: 'slow', message: 'fileOf' })))
      .toEqual({ type: 'error', id: 'f1', code: 'slow', message: 'fileOf' });
  });

  it('blanks the value of a secure field', () => {
    const reply = parseContextLine(JSON.stringify({
      type: 'systemText', id: 's1', selection: '', spotTexts: '', focusKind: 'field', focusLabel: 'Password',
      focusValue: 'hunter2', focusSecure: true, address: '',
    }));
    expect(reply).toMatchObject({ layer: { focus: { kind: 'field', label: 'Password', value: '', secure: true } } });
    expect(JSON.stringify(reply)).not.toContain('hunter2');
    const noFlag = { type: 'systemText', id: 's1', selection: '', spotTexts: '', focusKind: 'field', focusLabel: '',
      focusValue: '', address: '' };
    expect(parseContextLine(JSON.stringify({ ...noFlag, focusSecure: 'true' }))).toBeNull();
    expect(parseContextLine(JSON.stringify(noFlag))).toBeNull();
  });

  it('splits spot texts on the record separator', () => {
    const reply = parseContextLine(JSON.stringify({
      type: 'systemText', id: 's1', selection: '', spotTexts: 'first line\u001esecond, with\ttab\u001e', focusKind: '',
      focusLabel: '', focusValue: '', focusSecure: false, address: '',
    }));
    expect(reply).toMatchObject({ layer: { spotTexts: ['first line', 'second, with\ttab', ''] } });
  });

  it('rejects a fileOf reply with an unknown how', () => {
    const fileOf = { type: 'fileOf', id: 'f1', path: '', address: '', how: 'none' };
    expect(parseContextLine(JSON.stringify(fileOf))).toEqual(fileOf);
    expect(parseContextLine(JSON.stringify({ ...fileOf, how: 'guess' }))).toBeNull();
    expect(parseContextLine(JSON.stringify({ ...fileOf, path: 3 }))).toBeNull();
    expect(parseContextLine(JSON.stringify({ type: 'marks', id: 'm1', path: 'a.tsv', count: -1 }))).toBeNull();
    expect(parseContextLine(JSON.stringify({ type: 'marks', id: 'm1', path: '', count: 0 }))).toBeNull();
  });
});

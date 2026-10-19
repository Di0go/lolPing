import { describe, expect, it } from 'vitest';
import { captureCommand, parseContextLine } from '../../../src/shared/teammate/contextProtocol';

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
});

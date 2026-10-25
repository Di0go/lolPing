import { describe, expect, it } from 'vitest';
import type { Shot } from '../../../src/shared/teammate/coords';
import {
  parseMarksFile, resolveTarget, selectMarks, snapPoint, type Mark, type RawMark,
} from '../../../src/shared/teammate/marks';

const mark = (kind: RawMark['kind'], x: number, y: number, w: number, h: number, text = ''): RawMark => ({
  kind, box: { x, y, w, h }, text,
});

describe('parseMarksFile', () => {
  it('parses the helper file and skips bad lines', () => {
    const file = [
      'button\t100\t200\t80\t30\tSave',
      'text\t10\t20\t300\t18\t  Hello   world  ',
      'weird\t1\t2\t3\t4\tfoo',
      'link\t1\t2\t3',
      'field\ta\t2\t3\t4\tx',
      'tab\t5\t6\t0\t10\tzero width',
      '',
      `item\t7\t8\t9\t10\t${'x'.repeat(200)}\r`,
    ].join('\n');
    const marks = parseMarksFile(file);
    expect(marks.map((m) => [m.kind, m.box, m.text.length])).toEqual([
      ['button', { x: 100, y: 200, w: 80, h: 30 }, 4],
      ['text', { x: 10, y: 20, w: 300, h: 18 }, 'Hello   world'.length],
      ['other', { x: 1, y: 2, w: 3, h: 4 }, 3],
      ['item', { x: 7, y: 8, w: 9, h: 10 }, 120],
    ]);
    expect(marks[1].text).toBe('Hello   world');
  });
});

describe('selectMarks', () => {
  const dist = (m: RawMark): number => Math.hypot(m.box.x - 1000, m.box.y - 1000);

  it('keeps marks within 600 px of any spot and at most 150', () => {
    const spot = { x: 1000, y: 1000 };
    const near = mark('button', 1100, 1000, 50, 20, 'Near');
    const edge = mark('button', 1600, 1000, 50, 20, 'Edge'); // its box starts exactly 600 px from the spot
    const far = mark('button', 1601, 1000, 50, 20, 'Far');
    const around = mark('field', 0, 0, 3000, 3000, 'Huge'); // the spot is inside its box
    expect(selectMarks([far, near, edge, around], [spot]).map((m) => m.text).sort()).toEqual(['Edge', 'Huge', 'Near']);

    const many = Array.from({ length: 400 }, (_, i) => (
      mark('item', 1000 + (i % 40) * 10, 1000 + Math.floor(i / 40) * 10, 5, 5, `i${i}`)
    ));
    const picked = selectMarks(many, [spot]);
    expect(picked).toHaveLength(150);
    const sorted = many.slice().sort((a, b) => dist(a) - dist(b));
    expect(Math.max(...picked.map(dist))).toBeLessThanOrEqual(dist(sorted[150]));
  });

  it('measures the distance to the nearest of several spots', () => {
    const a = mark('button', 0, 0, 10, 10, 'A');
    const b = mark('button', 5000, 0, 10, 10, 'B');
    const kept = selectMarks([a, b], [{ x: 100, y: 0 }, { x: 4900, y: 0 }]);
    expect(kept.map((m) => m.text)).toEqual(['A', 'B']);
    expect(selectMarks([a, b], [])).toEqual([]);
  });

  it('drops a text mark inside a control with the same text', () => {
    const button = mark('button', 100, 100, 100, 40, 'Save');
    const label = mark('text', 120, 110, 40, 20, 'save');
    const other = mark('text', 120, 110, 40, 20, 'Cancel');
    const outside = mark('text', 300, 100, 40, 20, 'Save');
    const kept = selectMarks([label, button, other, outside], [{ x: 150, y: 120 }]);
    expect(kept.map((m) => `${m.kind}:${m.text}`).sort()).toEqual(['button:Save', 'text:Cancel', 'text:Save']);
  });

  it('sorts marks in reading order', () => {
    const a = mark('text', 300, 105, 40, 10, 'a'); // centre y 110: row 5
    const b = mark('text', 50, 112, 40, 10, 'b'); // centre y 117: row 5, further left
    const c = mark('text', 10, 130, 40, 10, 'c'); // centre y 135: row 6
    const d = mark('text', 500, 10, 40, 10, 'd'); // row 0
    expect(selectMarks([a, c, d, b], [{ x: 200, y: 100 }]).map((m) => m.text)).toEqual(['d', 'b', 'a', 'c']);
  });
});

describe('snapPoint', () => {
  const marks: Mark[] = [
    mark('button', 100, 100, 80, 40, 'OK'),
    mark('field', 90, 90, 300, 100, 'Form'),
    mark('link', 500, 100, 60, 20, 'Docs'),
    mark('text', 100, 300, 200, 20, 'A line of text'),
  ];

  it('snaps a point inside a button to its centre', () => {
    expect(snapPoint({ x: 105, y: 110 }, marks)).toEqual({ x: 140, y: 120 }); // the smaller of two controls
    expect(snapPoint({ x: 350, y: 180 }, marks)).toEqual({ x: 240, y: 140 });
  });

  it('snaps to the nearest control within 24 px only', () => {
    expect(snapPoint({ x: 530, y: 135 }, marks)).toEqual({ x: 530, y: 110 }); // 15 px below Docs
    expect(snapPoint({ x: 530, y: 150 }, marks)).toEqual({ x: 530, y: 150 }); // 30 px below
    expect(snapPoint({ x: 575, y: 110 }, marks)).toEqual({ x: 530, y: 110 }); // 15 px right
    expect(snapPoint({ x: 530, y: 144 }, marks)).toEqual({ x: 530, y: 110 }); // exactly 24 px
  });

  it('keeps the x of a point on a text line', () => {
    expect(snapPoint({ x: 250, y: 303 }, marks)).toEqual({ x: 250, y: 310 });
    expect(snapPoint({ x: 250, y: 330 }, marks)).toEqual({ x: 250, y: 310 }); // 10 px below the line
    expect(snapPoint({ x: 250, y: 290 }, marks)).toEqual({ x: 250, y: 310 }); // 10 px above
    expect(snapPoint({ x: 320, y: 310 }, marks)).toEqual({ x: 320, y: 310 }); // beyond the line's x range
    expect(snapPoint({ x: 250, y: 340 }, marks)).toEqual({ x: 250, y: 340 }); // 20 px below
  });

  it('snaps only onto small controls, so a word in a big box or a spot on an image stays put', () => {
    const big: Mark[] = [
      mark('field', 1000, 1000, 900, 500, 'Compose'),
      mark('text', 1020, 1100, 700, 20, 'Dear team, the numbers are in'),
      mark('other', 2000, 1000, 600, 400, 'Sales chart'),
      mark('other', 3000, 1000, 80, 30, 'icon'),
      mark('button', 2100, 1100, 80, 30, 'Send'),
    ];
    expect(snapPoint({ x: 1300, y: 1104 }, big)).toEqual({ x: 1300, y: 1110 }); // the line, not the box centre
    expect(snapPoint({ x: 1500, y: 1400 }, big)).toEqual({ x: 1500, y: 1400 });
    expect(snapPoint({ x: 2400, y: 1300 }, big)).toEqual({ x: 2400, y: 1300 }); // a bar in a chart image
    expect(snapPoint({ x: 3010, y: 1010 }, big)).toEqual({ x: 3010, y: 1010 }); // `other` is never a target
    expect(snapPoint({ x: 2105, y: 1105 }, big)).toEqual({ x: 2140, y: 1115 }); // the button inside the image
  });

  it('leaves a point near nothing where it is', () => {
    expect(snapPoint({ x: 900, y: 900 }, marks)).toEqual({ x: 900, y: 900 });
    expect(snapPoint({ x: 5, y: 5 }, [])).toEqual({ x: 5, y: 5 });
  });
});

describe('resolveTarget', () => {
  const shot: Shot = {
    area: { x: 1920, y: 0, w: 3200, h: 1800 },
    overview: { w: 1600, h: 900 },
    zooms: [],
  };
  const ctx = { spots: [{ x: 2500, y: 400 }], marks: [mark('button', 3000, 600, 100, 40, 'Go')], shot };

  it('drops points off the display and unknown spots', () => {
    expect(resolveTarget({ spot: 1 }, ctx)).toEqual({ x: 2500, y: 400 });
    expect(resolveTarget({ spot: 2 }, ctx)).toBeNull();
    expect(resolveTarget({ spot: 0 }, ctx)).toBeNull();
    expect(resolveTarget({ x: 1600, y: 10 }, ctx)).toBeNull();
    expect(resolveTarget({ x: -1, y: 10 }, ctx)).toBeNull();
  });

  it('maps overview pixels to the screen and snaps them onto the control under them', () => {
    expect(resolveTarget({ x: 560, y: 310 }, ctx)).toEqual({ x: 3050, y: 620 }); // lands at 3040,620 in the button
    expect(resolveTarget({ x: 100, y: 100 }, ctx)).toEqual({ x: 2120, y: 200 });
  });
});

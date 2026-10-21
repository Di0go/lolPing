import { describe, expect, it } from 'vitest';
import { overviewToPhysical, physicalBoxToOverview, physicalToOverview, receiptPoint, zoomRect, type Shot } from '../../../src/shared/teammate/coords';
import { physicalToLocal, type DisplayMap } from '../../../src/main/coords';

const shot = (area: Shot['area'], overview: Shot['overview']): Shot => ({ area, overview, zooms: [] });

describe('teammate coords', () => {
  it('maps an overview point back to physical pixels', () => {
    const s = shot({ x: 0, y: 0, w: 3200, h: 1800 }, { w: 1600, h: 900 });
    expect(overviewToPhysical(s, { x: 800, y: 450 })).toEqual({ x: 1600, y: 900 });
  });

  it('returns null outside the display', () => {
    const s = shot({ x: 0, y: 0, w: 3200, h: 1800 }, { w: 1600, h: 900 });
    expect(overviewToPhysical(s, { x: -1, y: 10 })).toBeNull();
    expect(overviewToPhysical(s, { x: 1600, y: 10 })).toBeNull();
    expect(overviewToPhysical(s, { x: 10, y: 900 })).toBeNull();
  });

  it('maps an overview point on a 150 % secondary display', () => {
    const s = shot({ x: 1920, y: 0, w: 2880, h: 1620 }, { w: 1600, h: 900 });
    const maps: DisplayMap[] = [
      { id: 1, scale: 1, dip: { x: 0, y: 0, width: 1920, height: 1080 }, phys: { x: 0, y: 0, width: 1920, height: 1080 } },
      { id: 2, scale: 1.5, dip: { x: 1920, y: 0, width: 1920, height: 1080 }, phys: { x: 1920, y: 0, width: 2880, height: 1620 } },
    ];
    const phys = overviewToPhysical(s, { x: 800, y: 450 });
    expect(phys).toEqual({ x: 3360, y: 810 });
    const local = phys && physicalToLocal(phys.x, phys.y, maps);
    expect(local).toEqual({ displayId: 2, x: 960, y: 540 });
  });

  it('maps physical pixels and boxes onto the overview', () => {
    const s = shot({ x: 1920, y: 0, w: 2880, h: 1620 }, { w: 1600, h: 900 });
    expect(physicalToOverview(s, { x: 3360, y: 810 })).toEqual({ x: 800, y: 450 });
    expect(physicalBoxToOverview(s, { x: 1920, y: 0, w: 288, h: 162 })).toEqual({ x: 0, y: 0, w: 160, h: 90 });
  });

  it('keeps the zoom inside the display near a corner', () => {
    const display = { x: 100, y: 50, w: 1920, h: 1080 };
    expect(zoomRect(display, { x: 110, y: 60 })).toEqual({ x: 100, y: 50, w: 1000, h: 750 });
    expect(zoomRect(display, { x: 2010, y: 1120 })).toEqual({ x: 1020, y: 380, w: 1000, h: 750 });
  });

  it('shrinks the zoom to a display smaller than the crop', () => {
    expect(zoomRect({ x: 0, y: 0, w: 800, h: 600 }, { x: 400, y: 300 })).toEqual({ x: 0, y: 0, w: 800, h: 600 });
  });

  it('keeps the receipt on screen at the right edge', () => {
    const display = { x: 0, y: 0, w: 1920, h: 1080 };
    expect(receiptPoint({ x: 500, y: 500 }, display)).toEqual({ x: 540, y: 460 });
    expect(receiptPoint({ x: 1915, y: 5 }, display)).toEqual({ x: 1890, y: 30 });
    expect(receiptPoint({ x: 1, y: 1079 }, display)).toEqual({ x: 41, y: 1039 });
  });
});

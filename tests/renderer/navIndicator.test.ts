import { describe, expect, it } from 'vitest';
import { barFrames } from '../../src/renderer/settings/navIndicator';

describe('barFrames', () => {
  it('stretches down over the gap, then settles on the lower item', () => {
    expect(barFrames(10, 100, 16)).toEqual([
      { top: '10px', height: '16px' },
      { top: '10px', height: '106px', offset: 0.5 },
      { top: '100px', height: '16px' },
    ]);
  });

  it('stretches up from the top of the higher item when moving up', () => {
    expect(barFrames(100, 10, 16)).toEqual([
      { top: '100px', height: '16px' },
      { top: '10px', height: '106px', offset: 0.5 },
      { top: '10px', height: '16px' },
    ]);
  });

  it('has no frames when the bar stays where it is', () => {
    expect(barFrames(42, 42, 16)).toEqual([]);
  });
});

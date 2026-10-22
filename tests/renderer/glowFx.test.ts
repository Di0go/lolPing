import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GLOW_MS, GlowStage, spawnGlow } from '../../src/renderer/overlay/glowFx';
import { tagColorCss } from '../../src/shared/roomColors';

/** Just enough of the DOM for spawnGlow: an element with a style, a dataset and a parent it can leave. */
class FakeElement {
  className = '';
  readonly dataset: Record<string, string> = {};
  readonly props = new Map<string, string>();
  readonly style = {
    left: '', top: '', width: '', height: '',
    setProperty: (name: string, value: string) => void this.props.set(name, value),
  };
  parent: FakeElement | null = null;
  children: FakeElement[] = [];
  append(...els: FakeElement[]): void {
    for (const el of els) {
      el.parent = this;
      this.children.push(el);
    }
  }
  remove(): void {
    if (!this.parent) return;
    this.parent.children = this.parent.children.filter((c) => c !== this);
    this.parent = null;
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('document', { createElement: () => new FakeElement() });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('spawnGlow', () => {
  it('outlines the field box in the teammate\'s colour as one of its marks, and goes after 900 ms', () => {
    const layer = new FakeElement();
    const glow = { box: { x: 10, y: 20, w: 200, h: 24 }, color: 3, rgb: [10, 20, 30] as const, delay: 0 };
    spawnGlow(layer as unknown as HTMLElement, glow);
    const [el] = layer.children;
    expect(el.className).toBe('mate-glow');
    // mate:clear and mate:fade find the teammate's marks by their owner.
    expect(el.dataset.owner).toBe('mate');
    expect(el.style).toMatchObject({ left: '10px', top: '20px', width: '200px', height: '24px' });
    expect(el.props.get('--glow')).toBe(tagColorCss(3, [10, 20, 30]));
    vi.advanceTimersByTime(GLOW_MS - 1);
    expect(layer.children).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(layer.children).toHaveLength(0);
  });
});

describe('GlowStage', () => {
  const glow = (delay: number) => ({ box: { x: 10, y: 20, w: 200, h: 24 }, color: 3, rgb: null, delay });

  it('lights the fields of a fill after their delays, and drops the ones still waiting when cleared', () => {
    const layer = new FakeElement();
    const stage = new GlowStage(layer as unknown as HTMLElement);
    stage.spawn(glow(0));
    stage.spawn(glow(120));
    stage.spawn(glow(240));
    vi.advanceTimersByTime(0);
    expect(layer.children).toHaveLength(1);
    vi.advanceTimersByTime(120);
    expect(layer.children).toHaveLength(2);
    // A pause or a new ask: the third field never lights up.
    stage.clear();
    vi.advanceTimersByTime(1000);
    expect(layer.children).toHaveLength(0);
  });
});

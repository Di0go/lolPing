import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawnPing } from '../../src/renderer/overlay/pingFx';
import { pingById, type PingDef } from '../../src/shared/pings';

/** Just enough of the DOM for spawnPing: elements with classes and children that can be removed. */
class FakeElement {
  className = '';
  textContent = '';
  readonly dataset: Record<string, string> = {};
  src = '';
  onerror: (() => void) | null = null;
  parent: FakeElement | null = null;
  children: FakeElement[] = [];
  readonly style = { setProperty: () => undefined };
  get childElementCount(): number {
    return this.children.length;
  }
  get firstElementChild(): FakeElement | null {
    return this.children[0] ?? null;
  }
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

const danger = pingById('danger') as PingDef;

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('document', { createElement: () => new FakeElement() });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('spawnPing', () => {
  it('removes a ping once its duration is over', () => {
    const layer = new FakeElement();
    spawnPing(layer as unknown as HTMLElement, danger, 10, 20, { sizePx: 110, durationS: 3 });
    expect(layer.children).toHaveLength(1);
    vi.advanceTimersByTime(3200);
    expect(layer.children).toHaveLength(0);
  });

  it('leaves a kept ping on screen past its duration, for the caller to remove', () => {
    const layer = new FakeElement();
    const el = spawnPing(layer as unknown as HTMLElement, danger, 10, 20, { sizePx: 110, durationS: 3, keep: true });
    expect(layer.children[0].className).toBe('ping kept');
    vi.advanceTimersByTime(60_000);
    expect(layer.children).toHaveLength(1);
    el.remove();
    expect(layer.children).toHaveLength(0);
  });
});

describe('spawnPing for the teammate', () => {
  const classes = (el: FakeElement): string[] => el.children.map((c) => c.className);

  it('draws a teammate ping with its label', () => {
    const layer = new FakeElement();
    spawnPing(layer as unknown as HTMLElement, danger, 10, 20, {
      sizePx: 110, durationS: 3, owner: 'mate', label: 'typo here', tag: { name: 'AI', color: 3 },
    });
    const root = layer.children[0];
    expect(root.dataset.owner).toBe('mate');
    expect(classes(root)).toContain('ground');
    expect(root.children.find((c) => c.className === 'label')?.textContent).toBe('typo here');
    expect(root.children.find((c) => c.className === 'tag')?.textContent).toBe('AI');
  });

  it('marks a thinking tag with dots, and leaves a room member\'s ping without an owner', () => {
    const layer = new FakeElement();
    spawnPing(layer as unknown as HTMLElement, danger, 0, 0, {
      sizePx: 110, durationS: 3, owner: 'mate', thinking: true, tag: { name: 'AI', color: 3 },
    });
    spawnPing(layer as unknown as HTMLElement, danger, 0, 0, { sizePx: 110, durationS: 3, tag: { name: 'Bo', color: 1 } });
    expect(layer.children[0].children.find((c) => c.className.startsWith('tag'))?.className).toBe('tag dots');
    expect(classes(layer.children[0])).toContain('ground');
    expect(layer.children[1].dataset.owner).toBeUndefined();
    expect(classes(layer.children[1])).not.toContain('label');
  });

  it('keeps the teammate’s receipt on screen until the caller removes it', () => {
    const layer = new FakeElement();
    spawnPing(layer as unknown as HTMLElement, danger, 0, 0, {
      sizePx: 110, durationS: 3, owner: 'mate', thinking: true, keep: true, tag: { name: 'AI', color: 3 },
    });
    vi.advanceTimersByTime(60_000);
    expect(layer.children).toHaveLength(1);
    expect(layer.children[0].className).toBe('ping kept');
  });

  it('draws only the name tag with its dots for a tag-only receipt', () => {
    const layer = new FakeElement();
    spawnPing(layer as unknown as HTMLElement, danger, 0, 0, {
      sizePx: 110, durationS: 3, owner: 'mate', thinking: true, keep: true, tagOnly: true, tag: { name: 'AI', color: 3 },
    });
    const root = layer.children[0];
    expect(root.className).toBe('ping kept tag-only');
    expect(classes(root)).toEqual(['tag dots']);
  });
});

import { describe, expect, it } from 'vitest';
import { bubbleMs, splitLine } from '../../../src/shared/teammate/line';

describe('splitLine', () => {
  it('cuts at a sentence end inside 90 characters', () => {
    const first = 'Group mid and take the dragon.';
    const text = `${first} After that, push top lane while they are down and keep the wards up near river.`;
    const { line, rest } = splitLine(text, 'en');
    expect(line).toBe(first);
    expect(rest.startsWith('After that')).toBe(true);
  });

  it('cuts at a word with an ellipsis when there is no sentence end', () => {
    const text = 'word '.repeat(40).trim();
    const { line, rest } = splitLine(text, 'en');
    expect(line.length).toBeLessThanOrEqual(90);
    expect(line.endsWith('…')).toBe(true);
    expect(`${line.slice(0, -1)} ${rest}`.replace(/\s+/g, ' ')).toBe(text);
  });

  it('uses 45 characters for Chinese', () => {
    const text = '先去中路集合。'.repeat(2) + '然后一起打龙，不要分开走，注意视野和对面打野的位置，随时准备撤退。';
    const { line } = splitLine(text, 'zh-CN');
    expect(line.length).toBeLessThanOrEqual(45);
    expect(line.endsWith('。')).toBe(true);
    const noStop = '甲'.repeat(100);
    const cut = splitLine(noStop, 'zh-CN');
    expect(cut.line).toBe('甲'.repeat(44) + '…');
    expect(cut.rest).toBe('甲'.repeat(56));
  });

  it('keeps a short reply whole', () => {
    expect(splitLine('Go mid.', 'en')).toEqual({ line: 'Go mid.', rest: '' });
  });
});

describe('bubbleMs', () => {
  it('gives longer lines more time', () => {
    expect(bubbleMs('')).toBe(6_000);
    expect(bubbleMs('x'.repeat(15))).toBe(7_000);
    expect(bubbleMs('x'.repeat(90))).toBe(12_000);
    expect(bubbleMs('x'.repeat(90))).toBeGreaterThan(bubbleMs('x'.repeat(10)));
  });
});

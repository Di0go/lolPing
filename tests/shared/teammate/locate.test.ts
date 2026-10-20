import { describe, expect, it } from 'vitest';
import { locate, normalize, PAGE_CHARS } from '../../../src/shared/teammate/locate';

const section = (n: number, len = 1000): { text: string } => ({
  text: `unique${n} `.repeat(Math.ceil(len / 8)).slice(0, len),
});

describe('normalize', () => {
  it('folds width and case and collapses whitespace and punctuation', () => {
    expect(normalize('  Ｈello,\n\tWorld!!  ')).toBe('hello world');
  });
});

describe('locate', () => {
  it('has a page of 3000 characters', () => {
    expect(PAGE_CHARS).toBe(3000);
  });

  it('picks the section the visible text comes from', () => {
    const sections = [
      { text: 'Alpha beta gamma delta epsilon zeta eta theta iota kappa lambda' },
      { text: 'The quick brown fox jumps over the lazy dog near the river bank' },
      { text: 'Completely different words about pastry, bread and butter' },
    ];
    expect(locate(sections, 'quick brown fox   jumps over, the lazy dog', 100)).toEqual({ from: 1, to: 1 });
  });

  it('adds neighbours within the budget, the next one first', () => {
    const sections = [0, 1, 2, 3, 4, 5].map((n) => section(n));
    const visible = sections[2].text.slice(100, 160);
    expect(locate(sections, visible, 3000)).toEqual({ from: 1, to: 3 });
    expect(locate(sections, visible, 2000)).toEqual({ from: 2, to: 3 });
    expect(locate(sections, visible, 1500)).toEqual({ from: 2, to: 2 });
    expect(locate(sections, visible, 100_000)).toEqual({ from: 0, to: 5 });
  });

  it('finds the page for Chinese text', () => {
    const pages = [
      '甲方应当在合同签订之日起十个工作日内向乙方支付首期款项并提供有效发票用于结算',
      '乙方负责按照附件所列的技术规格完成软件开发并在验收期内修复全部已知缺陷问题',
      '双方同意因本合同引起的任何争议首先通过友好协商解决协商不成的提交仲裁委员会',
      '本合同自双方签字盖章之日起生效有效期为三年期满前三十日内可书面协商续签事宜',
    ].map((t) => ({ text: t.repeat(4) }));
    // An OCR line from page 3 (index 2) with one wrong character (争 read as 净).
    const visible = '双方同意因本合同引起的任何净议首先通过友好协商解决';
    expect(locate(pages, visible, 100)).toEqual({ from: 2, to: 2 });
  });

  it('falls back to the first sections when nothing matches', () => {
    const sections = [section(0), section(1), section(2)];
    expect(locate(sections, '', 2000)).toEqual({ from: 0, to: 1 });
    expect(locate(sections, 'zzzzzzzzzzzzzzzzzzzzzzzz', 2500)).toEqual({ from: 0, to: 1 });
  });

  it('returns null without sections', () => {
    expect(locate([], 'anything', 3000)).toBeNull();
  });
});

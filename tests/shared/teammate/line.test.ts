import { describe, expect, it } from 'vitest';
import { bubbleMs, lineFromMarkdown, splitLine } from '../../../src/shared/teammate/line';

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

describe('lineFromMarkdown', () => {
  it('takes the first sentence of the first block, without its Markdown marks', () => {
    expect(lineFromMarkdown('## Problems\n\n- **B4** counts row 3 twice. It should skip it.\n- C2 is empty.', 'en'))
      .toBe('Problems');
    expect(lineFromMarkdown('**B4** counts [row 3](https://x.test) twice. It should skip it.', 'en'))
      .toBe('B4 counts row 3 twice. It should skip it.');
    expect(lineFromMarkdown('- `=A3/B3` fails when B3 is 0, which it is in this sheet, so the cell shows #DIV/0! here.', 'en'))
      .toBe('=A3/B3 fails when B3 is 0, which it is in this sheet, so the cell shows #DIV/0! here.');
  });

  it('takes only the first item of a list', () => {
    expect(lineFromMarkdown('- One thing is wrong.\n  It is in B4.\n- Another.', 'en')).toBe('One thing is wrong. It is in B4.');
    expect(lineFromMarkdown('1. Open File.\n2. Choose Export.', 'en')).toBe('Open File.');
  });

  it('skips code, tables and images to the first prose', () => {
    expect(lineFromMarkdown('```js\nconst a = 1;\n```\n\nThe constant is never used.', 'en')).toBe('The constant is never used.');
    expect(lineFromMarkdown('| a | b |\n| - | - |\n\nTwo columns.', 'en')).toBe('Two columns.');
    expect(lineFromMarkdown('![chart](c.png)\n\nSales rose.', 'en')).toBe('Sales rose.');
    expect(lineFromMarkdown('```\nonly code', 'en')).toBe('');
  });

  it('keeps to the bubble\'s length', () => {
    const zh = '这一行很长'.repeat(20);
    expect([...lineFromMarkdown(zh, 'zh-CN')]).toHaveLength(45);
    expect(lineFromMarkdown('word '.repeat(40), 'en').length).toBeLessThanOrEqual(90);
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

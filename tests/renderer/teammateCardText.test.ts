import { describe, expect, it } from 'vitest';
import { strings } from '../../src/shared/i18n';
import { parseMateAction } from '../../src/shared/teammateIpc';
import { copyText, footerText, putLabel } from '../../src/renderer/teammate/cardText';

const footer = { profile: 'Default', model: 'gpt-x', tokens: 1234, used: ['screen', 'file'] };

describe('cardText', () => {
  it('copies the latest answer without its line, so a written reply pastes as it is', () => {
    const entries = [
      { kind: 'ask' as const, label: 'Explain', markdown: 'what?' },
      { kind: 'answer' as const, label: 'Mate', line: 'It is a typo.', markdown: 'one' },
      { kind: 'ask' as const, label: 'Do it', markdown: '' },
      { kind: 'answer' as const, label: 'Mate', line: 'Wrote a reply.', markdown: 'Sure, Friday works.' },
    ];
    expect(copyText(entries)).toBe('Sure, Friday works.');
    expect(copyText([{ kind: 'answer', label: 'Mate', line: 'Only a line.', markdown: '' }])).toBe('Only a line.');
    expect(copyText([])).toBe('');
  });

  it('cuts a copy to what the main process accepts', () => {
    const long = copyText([{ kind: 'answer', label: 'Mate', markdown: 'x'.repeat(150_000) }]);
    expect(parseMateAction({ t: 'copy', text: long }, 'card')).not.toBeNull();
  });

  it('joins the footer with each language’s own separators', () => {
    expect(footerText(footer, strings('en').teammate.ui)).toBe('Default · gpt-x · 1,234 tokens · Used: screen, file');
    expect(footerText(footer, strings('zh-CN').teammate.ui)).toBe('Default · gpt-x · 1,234 个词元 · 用到：screen、file');
    expect(footerText({ profile: '', model: 'm', tokens: null, used: [] }, strings('en').teammate.ui)).toBe('m');
  });

  it('names the put button after the action it carries out, and shows none without one', () => {
    const en = strings('en').teammate.ui;
    expect(putLabel('paste', en)).toBe('Paste');
    expect(putLabel('replace', en)).toBe('Replace');
    expect(putLabel('fill', en)).toBe('Fill');
    expect(putLabel('ready', en)).toBe('Paste when ready');
    expect(putLabel(null, en)).toBeNull();
    expect(putLabel('ready', strings('zh-CN').teammate.ui)).toBe('准备好后粘贴');
  });
});

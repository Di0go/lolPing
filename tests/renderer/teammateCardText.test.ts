import { describe, expect, it } from 'vitest';
import { strings } from '../../src/shared/i18n';
import { parseMateAction } from '../../src/shared/teammateIpc';
import { copyAllText, footerText } from '../../src/renderer/teammate/cardText';

const footer = { profile: 'Default', model: 'gpt-x', tokens: 1234, used: ['screen', 'file'] };

describe('cardText', () => {
  it('copies the answers only, cut to what the main process accepts', () => {
    const entries = [
      { kind: 'ask' as const, label: 'You', markdown: 'what?' },
      { kind: 'answer' as const, label: 'Mate', markdown: 'one' },
      { kind: 'answer' as const, label: 'Mate', markdown: 'two' },
    ];
    expect(copyAllText(entries)).toBe('one\n\ntwo');
    const long = copyAllText([{ kind: 'answer', label: 'Mate', markdown: 'x'.repeat(150_000) }]);
    expect(parseMateAction({ t: 'copy', text: long }, 'card')).not.toBeNull();
  });

  it('joins the footer with each language’s own separators', () => {
    expect(footerText(footer, strings('en').teammate.ui)).toBe('Default · gpt-x · 1,234 tokens · Used: screen, file');
    expect(footerText(footer, strings('zh-CN').teammate.ui)).toBe('Default · gpt-x · 1,234 个词元 · 用到：screen、file');
    expect(footerText({ profile: '', model: 'm', tokens: null, used: [] }, strings('en').teammate.ui)).toBe('m');
  });
});

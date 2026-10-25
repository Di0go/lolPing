import { describe, expect, it } from 'vitest';
import { strings } from '../../src/shared/i18n';
import { parseMateAction } from '../../src/shared/teammateIpc';
import {
  bubbleButtons, cardButtons, consentKey, consentMore, copyText, footerText, formKey, PUT_ARM_MS, PutGuard, putLabel,
} from '../../src/renderer/teammate/cardText';

const footer = { profile: 'Default', model: 'gpt-x', route: '', tokens: 1234, used: ['screen', 'file'] };

describe('cardText', () => {
  it('says what the detail of an agent card left out, in either language', () => {
    const en = strings('en').teammate.ui;
    const zh = strings('zh-CN').teammate.ui;
    expect(consentMore({}, en)).toBe('');
    expect(consentMore({ moreLines: 1 }, en)).toBe('+1 more line');
    expect(consentMore({ moreLines: 12, moreEdits: 1 }, en)).toBe('+12 more lines · +1 more edit');
    expect(consentMore({ moreEdits: 3 }, en)).toBe('+3 more edits');
    expect(consentMore({ moreLines: 12, moreEdits: 3 }, zh)).toBe('还有 12 行 · 还有 3 处修改');
  });

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
    expect(footerText({ profile: '', model: 'm', route: '', tokens: null, used: [] }, strings('en').teammate.ui))
      .toBe('m');
    expect(footerText({ ...footer, route: 'Rule: Code' }, strings('en').teammate.ui))
      .toBe('Default · gpt-x · Rule: Code · 1,234 tokens · Used: screen, file');
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

  it('adds the put button after every other button, so none moves from under the pointer', () => {
    expect(bubbleButtons(true, null)).toEqual(['more']);
    expect(bubbleButtons(true, 'Paste')).toEqual(['more', 'put']);
    expect(bubbleButtons(false, 'Paste')).toEqual(['put']);
    expect(bubbleButtons(false, null)).toEqual([]);
    expect(cardButtons(null)).toEqual(['copy', 'deep', 'history']);
    expect(cardButtons('Fill')).toEqual(['copy', 'deep', 'history', 'put']);
  });

  it('leaves Whole picture off a card that shows an answer only', () => {
    expect(cardButtons(null, true)).toEqual(['copy', 'history']);
  });

  it('ignores a put click that comes before the button has been there 400 ms', () => {
    let now = 1000;
    const guard = new PutGuard(() => now);
    expect(guard.click()).toBe(false); // no button
    guard.show('Paste');
    now += PUT_ARM_MS - 1;
    expect(guard.click()).toBe(false);
    guard.show('Paste'); // the same label drawn again keeps its time
    now += 1;
    expect(guard.click()).toBe(true);
    // Paste turning into Paste when ready is a new button under the pointer.
    guard.show('Paste when ready');
    now += 100;
    expect(guard.click()).toBe(false);
    now += PUT_ARM_MS;
    expect(guard.click()).toBe(true);
    guard.show(null);
    expect(guard.click()).toBe(false);
  });

  it('ignores a consent click within 400 ms of the card appearing or changing', () => {
    let now = 1000;
    const guard = new PutGuard(() => now);
    const card = {
      serial: 1, action: 'paste' as const, text: 'Paste this into Chrome?', detail: 'Friday works.', always: true,
    };
    guard.show(consentKey(card));
    now += PUT_ARM_MS - 1;
    expect(guard.click()).toBe(false); // a click meant for what was there before
    now += 1;
    expect(guard.click()).toBe(true);
    // The next card, even one that reads the same, is new under the pointer.
    guard.show(consentKey({ ...card, serial: 2 }));
    expect(guard.click()).toBe(false);
    now += PUT_ARM_MS;
    expect(guard.click()).toBe(true);
    guard.show(consentKey({ ...card, serial: 2, detail: 'Friday works for me.' }));
    expect(guard.click()).toBe(false);
  });

  it('ignores a fill click within 400 ms of the preview appearing or changing', () => {
    let now = 1000;
    const guard = new PutGuard(() => now);
    const rows = [{ id: 'f1', label: 'Name', value: 'Ada', checked: true }];
    guard.show(formKey({ serial: 1, rows }));
    now += PUT_ARM_MS - 1;
    expect(guard.click()).toBe(false); // a click meant for what was there before
    now += 1;
    expect(guard.click()).toBe(true);
    // The next preview, even with the same rows, is new under the pointer.
    guard.show(formKey({ serial: 2, rows }));
    expect(guard.click()).toBe(false);
    now += PUT_ARM_MS;
    expect(guard.click()).toBe(true);
    guard.show(formKey({ serial: 2, rows: [...rows, { id: 'f2', label: 'Email', value: 'a@b.c', checked: true }] }));
    expect(guard.click()).toBe(false);
  });
});

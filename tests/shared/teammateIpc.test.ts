import { describe, expect, it } from 'vitest';
import { parseMateAction, parseMateSize, type MateView } from '../../src/shared/teammateIpc';

const VIEWS: MateView[] = ['bubble', 'card', 'words', 'history', 'consent'];
const SAMPLES: Record<string, unknown> = {
  more: { t: 'more' },
  dismiss: { t: 'dismiss' },
  close: { t: 'close' },
  copy: { t: 'copy', text: 'npm test' },
  reply: { t: 'reply', text: 'and the second one?' },
  deep: { t: 'deep' },
  history: { t: 'history' },
  link: { t: 'link', url: 'https://example.com/a' },
  ask: { t: 'ask', text: 'what is this?', newThread: true },
  cancel: { t: 'cancel' },
  open: { t: 'open', id: 'a1b2-c3' },
  continue: { t: 'continue', id: 'a1b2-c3' },
  delete: { t: 'delete', id: 'a1b2-c3' },
  search: { t: 'search', query: 'invoice' },
  allow: { t: 'allow' },
  always: { t: 'always' },
  decline: { t: 'decline' },
};
const ALLOWED: Record<MateView, string[]> = {
  bubble: ['more', 'dismiss'],
  card: ['close', 'copy', 'reply', 'deep', 'history', 'link'],
  words: ['ask', 'cancel'],
  history: ['open', 'continue', 'delete', 'search'],
  consent: ['allow', 'always', 'decline'],
};

describe('parseMateAction', () => {
  it('accepts only the actions each view may send', () => {
    for (const view of VIEWS) {
      const accepted = Object.keys(SAMPLES).filter((t) => parseMateAction(SAMPLES[t], view) !== null);
      expect(accepted, view).toEqual(ALLOWED[view]);
    }
    expect(parseMateAction(SAMPLES.ask, 'words')).toEqual({ t: 'ask', text: 'what is this?', newThread: true });
    expect(parseMateAction(SAMPLES.search, 'history')).toEqual({ t: 'search', query: 'invoice' });
  });

  it('accepts only allow, always and decline from the consent view', () => {
    for (const t of ['allow', 'always', 'decline']) expect(parseMateAction({ t }, 'consent')).toEqual({ t });
    for (const t of ['more', 'dismiss', 'close', 'cancel', 'deep', 'history', 'copy', 'reply', 'ask', 'open', 'delete', 'search', 'link']) {
      expect(parseMateAction(SAMPLES[t], 'consent'), t).toBeNull();
    }
    for (const view of ['bubble', 'card', 'words', 'history'] as const) {
      for (const t of ['allow', 'always', 'decline']) expect(parseMateAction({ t }, view), `${view} ${t}`).toBeNull();
    }
    expect(parseMateAction({ t: 'allow', extra: 1 }, 'consent')).toEqual({ t: 'allow' });
    expect(parseMateAction({ t: 'Allow' }, 'consent')).toBeNull();
  });

  it('refuses non-web links and long replies', () => {
    for (const url of ['javascript:alert(1)', 'file:///C:/Windows/win.ini', 'lolping://app/x', 'not a url', 'data:text/html,x']) {
      expect(parseMateAction({ t: 'link', url }, 'card'), url).toBeNull();
    }
    expect(parseMateAction({ t: 'link', url: 'http://example.com' }, 'card')).toEqual({ t: 'link', url: 'http://example.com/' });
    expect(parseMateAction({ t: 'reply', text: 'x'.repeat(2000) }, 'card')).not.toBeNull();
    expect(parseMateAction({ t: 'reply', text: 'x'.repeat(2001) }, 'card')).toBeNull();
    expect(parseMateAction({ t: 'ask', text: 'x'.repeat(2001), newThread: false }, 'words')).toBeNull();
    expect(parseMateAction({ t: 'reply', text: '   ' }, 'card')).toBeNull();
  });

  it('refuses malformed fields and thread ids that could reach a path', () => {
    expect(parseMateAction(null, 'card')).toBeNull();
    expect(parseMateAction('close', 'card')).toBeNull();
    expect(parseMateAction({ t: 'ask', text: 'hi' }, 'words')).toBeNull();
    expect(parseMateAction({ t: 'copy', text: 5 }, 'card')).toBeNull();
    expect(parseMateAction({ t: 'open', id: '../secrets' }, 'history')).toBeNull();
    expect(parseMateAction({ t: 'delete', id: '' }, 'history')).toBeNull();
    expect(parseMateAction({ t: 'search', query: 'x'.repeat(201) }, 'history')).toBeNull();
  });
});

describe('parseMateSize', () => {
  it('keeps a reported size inside the limits of its view', () => {
    expect(parseMateSize({ width: 300, height: 120 }, 'bubble')).toEqual({ width: 300, height: 120 });
    expect(parseMateSize({ width: 9000, height: 9000 }, 'card')).toEqual({ width: 480, height: 600 });
    expect(parseMateSize({ width: 1, height: 1 }, 'card')).toEqual({ width: 200, height: 60 });
    expect(parseMateSize({ width: Number.NaN, height: 10 }, 'card')).toBeNull();
    expect(parseMateSize({ width: 100 }, 'bubble')).toBeNull();
    expect(parseMateSize({ width: 300, height: 100 }, 'history')).toBeNull();
  });
});

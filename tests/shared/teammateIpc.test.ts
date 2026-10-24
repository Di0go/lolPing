import { describe, expect, it } from 'vitest';
import { parseMateAction, parseMateDrag, parseMateSize, type MateView } from '../../src/shared/teammateIpc';

const VIEWS: MateView[] = ['bubble', 'card', 'words', 'history', 'consent', 'form'];
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
  cancel: { t: 'cancel', serial: 1 },
  open: { t: 'open', id: 'a1b2-c3' },
  continue: { t: 'continue', id: 'a1b2-c3' },
  delete: { t: 'delete', id: 'a1b2-c3' },
  search: { t: 'search', query: 'invoice' },
  openInAgent: { t: 'openInAgent', id: 'a1b2-c3' },
  allow: { t: 'allow', serial: 1 },
  always: { t: 'always', serial: 1 },
  decline: { t: 'decline', serial: 1 },
  fill: { t: 'fill', ids: ['f1', 'f2'], serial: 1 },
  put: { t: 'put' },
};
const ALLOWED: Record<MateView, string[]> = {
  bubble: ['more', 'dismiss', 'put'],
  card: ['close', 'copy', 'reply', 'deep', 'history', 'link', 'put'],
  words: ['ask', 'cancel'],
  history: ['open', 'continue', 'delete', 'search', 'openInAgent'],
  consent: ['allow', 'always', 'decline'],
  form: ['cancel', 'fill'],
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
    for (const t of ['allow', 'always', 'decline']) {
      expect(parseMateAction({ t, serial: 3 }, 'consent')).toEqual({ t, serial: 3 });
    }
    for (const t of ['more', 'dismiss', 'close', 'cancel', 'deep', 'history', 'copy', 'reply', 'ask', 'open', 'delete', 'search', 'link']) {
      expect(parseMateAction(SAMPLES[t], 'consent'), t).toBeNull();
    }
    for (const view of ['bubble', 'card', 'words', 'history'] as const) {
      for (const t of ['allow', 'always', 'decline']) {
        expect(parseMateAction({ t, serial: 1 }, view), `${view} ${t}`).toBeNull();
      }
    }
    expect(parseMateAction({ t: 'allow', serial: 0, extra: 1 }, 'consent')).toEqual({ t: 'allow', serial: 0 });
    expect(parseMateAction({ t: 'Allow', serial: 1 }, 'consent')).toBeNull();
  });

  it('takes a decision only with the serial of the card it was clicked on', () => {
    for (const serial of [undefined, -1, 1.5, '1', Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
      expect(parseMateAction({ t: 'allow', serial }, 'consent'), String(serial)).toBeNull();
      expect(parseMateAction({ t: 'fill', ids: ['f1'], serial }, 'form'), String(serial)).toBeNull();
      expect(parseMateAction({ t: 'cancel', serial }, 'form'), String(serial)).toBeNull();
    }
    // The words box's Cancel decides nothing that could be replaced: it needs none.
    expect(parseMateAction({ t: 'cancel' }, 'words')).toEqual({ t: 'cancel' });
  });

  it('accepts put from the bubble and the card', () => {
    // The click is the user's consent to paste or fill, so only the two windows that show the button may send it.
    expect(parseMateAction({ t: 'put' }, 'bubble')).toEqual({ t: 'put' });
    expect(parseMateAction({ t: 'put', mode: 'replace', text: 'x' }, 'card')).toEqual({ t: 'put' });
    for (const view of ['words', 'history', 'consent', 'form'] as const) {
      expect(parseMateAction({ t: 'put' }, view), view).toBeNull();
    }
    expect(parseMateAction({ t: 'Put' }, 'bubble')).toBeNull();
  });

  it('accepts fill with known ids only', () => {
    expect(parseMateAction({ t: 'fill', ids: ['f1', 'f2'], serial: 2 }, 'form'))
      .toEqual({ t: 'fill', ids: ['f1', 'f2'], serial: 2 });
    expect(parseMateAction({ t: 'fill', ids: ['f1'], serial: 2, extra: 1 }, 'form'))
      .toEqual({ t: 'fill', ids: ['f1'], serial: 2 });
    for (const ids of [[], 'f1', [1], ['f1', null], [''], ['x'.repeat(121)], Array.from({ length: 61 }, (_, i) => `f${i}`)]) {
      expect(parseMateAction({ t: 'fill', ids, serial: 2 }, 'form'), JSON.stringify(ids)).toBeNull();
    }
    // As long as the helper's longest field id, and no longer.
    expect(parseMateAction({ t: 'fill', ids: ['1'.repeat(120)], serial: 2 }, 'form')).not.toBeNull();
    expect(parseMateAction({ t: 'fill', serial: 2 }, 'form')).toBeNull();
    for (const view of ['bubble', 'card', 'words', 'history', 'consent'] as const) {
      expect(parseMateAction({ t: 'fill', ids: ['f1'], serial: 2 }, view), view).toBeNull();
    }
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
    expect(parseMateAction({ t: 'openInAgent', id: '..\\x' }, 'history')).toBeNull();
    expect(parseMateAction({ t: 'search', query: 'x'.repeat(201) }, 'history')).toBeNull();
  });
});

describe('parseMateDrag', () => {
  it('takes a drag of the bubble or card by its offset from where it started', () => {
    expect(parseMateDrag({ phase: 'start', dx: 0, dy: 0 }, 'bubble')).toEqual({ phase: 'start', dx: 0, dy: 0 });
    expect(parseMateDrag({ phase: 'move', dx: 40.4, dy: -12.6 }, 'card')).toEqual({ phase: 'move', dx: 40, dy: -13 });
    expect(parseMateDrag({ phase: 'end', dx: 5, dy: 5 }, 'bubble')).toEqual({ phase: 'end', dx: 5, dy: 5 });
    expect(parseMateDrag({ phase: 'move', dx: 5, dy: 5 }, 'consent')).toBeNull();
    expect(parseMateDrag({ phase: 'fly', dx: 5, dy: 5 }, 'card')).toBeNull();
    expect(parseMateDrag({ phase: 'move', dx: Number.NaN, dy: 5 }, 'card')).toBeNull();
    expect(parseMateDrag({ phase: 'move', dx: 1e6, dy: 5 }, 'card')).toBeNull();
    expect(parseMateDrag(null, 'card')).toBeNull();
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
    expect(parseMateSize({ width: 9000, height: 9000 }, 'form')).toEqual({ width: 420, height: 520 });
  });
});

import { describe, expect, it } from 'vitest';
import { ActionRunner, type ActionDeps, type RunInfo } from '../../../src/main/teammate/actions';
import { strings } from '../../../src/shared/i18n';
import { DEFAULT_SETTINGS, type Settings } from '../../../src/shared/settings';
import type { PasteRequest, PasteResult, SetFieldResult } from '../../../src/shared/teammate/contextProtocol';
import type { FormField } from '../../../src/shared/teammate/doRules';
import { tableHtml, tableTsv } from '../../../src/shared/teammate/grab';
import { DEFAULT_TEAMMATE } from '../../../src/shared/teammate/settings';
import type { ActionCall } from '../../../src/shared/teammate/tools';
import type { ConsentState, FormState } from '../../../src/shared/teammateIpc';

const t = strings('en').teammate.ui;
const TAG = { name: 'AI', color: 3, rgb: null };
const ASK_WINDOW = '263544';
const REPLY_BOX = { x: 900, y: 780, w: 400, h: 40 };

const info = (over: Partial<RunInfo> = {}): RunInfo => ({
  id: 'ask1', profileId: 'fast', tag: TAG, app: 'Chrome', window: ASK_WINDOW, lang: 'en',
  spot: { x: 1000, y: 800 }, at: { x: 500, y: 400 }, box: REPLY_BOX,
  focus: { label: 'Reply', secure: false }, selection: '', fields: [], ...over,
});

const paste = (text = 'Friday works.', mode: 'insert' | 'replace' = 'insert'): ActionCall => (
  { tool: 'paste', text, mode }
);

const field = (id: string, label: string, over: Partial<FormField> = {}): FormField => ({
  id, kind: 'text', label, group: '', value: '', secure: false, required: false, options: [],
  box: { x: 100, y: 100 * Number(id), w: 200, h: 20 }, ...over,
});
const FIELDS = [
  field('1', 'Name'),
  field('2', 'Email'),
  field('3', 'Password', { secure: true }),
  field('4', 'Size', { kind: 'combo', options: ['Small', 'Large'] }),
];

interface Options {
  permissions?: string[];
  clipboardForForms?: boolean;
  /** The helper's paste replies in order; the last one repeats. */
  pastes?: { result: PasteResult; restored?: boolean }[];
  setField?: Record<string, SetFieldResult>;
  /** The foreground window each time it is asked; the last one repeats. */
  foreground?: string[];
  cardHadFocus?: boolean;
  openPathError?: string;
}

/** Lets every pending promise settle, without moving the clock. */
async function flush(): Promise<void> {
  for (let i = 0; i < 100; i += 1) await Promise.resolve();
}

function harness(opts: Options = {}) {
  const log: [string, unknown][] = [];
  let clock = 0;
  const timers: { at: number; fn: () => void; live: boolean }[] = [];
  let settings: Settings = {
    ...DEFAULT_SETTINGS,
    teammate: {
      ...DEFAULT_TEAMMATE, permissions: [...(opts.permissions ?? [])],
      context: { ...DEFAULT_TEAMMATE.context, clipboardForForms: opts.clipboardForForms ?? false },
    },
  };
  const pastes = [...(opts.pastes ?? [{ result: 'ok' as const }])];
  const front = [...(opts.foreground ?? [ASK_WINDOW])];
  const next = <T>(list: T[]): T | undefined => (list.length > 1 ? list.shift() : list[0]);

  const deps: ActionDeps = {
    settings: () => settings,
    savePermissions: (permissions) => {
      settings = { ...settings, teammate: { ...settings.teammate, permissions } };
      log.push(['permissions', permissions]);
    },
    context: {
      paste: async (req) => {
        log.push(['paste', req]);
        const r = next(pastes) ?? { result: 'ok' };
        return { result: r.result, restored: r.restored ?? true };
      },
      setField: async (req) => {
        log.push(['setField', req]);
        return opts.setField?.[req.field] ?? 'ok';
      },
      foreground: async () => {
        const window = next(front) ?? '';
        log.push(['foreground', window]);
        return { app: 'Chrome', title: '', window };
      },
    },
    clipboard: { write: async (item) => void log.push(['clip', item]) },
    openPath: async (file) => {
      log.push(['openPath', file]);
      return opts.openPathError ?? '';
    },
    showInFolder: (file) => log.push(['showInFolder', file]),
    openExternal: async (url) => void log.push(['openExternal', url]),
    writeFile: async (file, text) => void log.push(['writeFile', { file, text }]),
    tempDir: () => 'tmp',
    windows: {
      showConsent: (at, s) => log.push(['consent', { at, ...s }]),
      hideConsent: () => log.push(['consentHidden', null]),
      showForm: (at, s) => log.push(['form', { at, ...s }]),
      hideForm: () => log.push(['formHidden', null]),
      cardHadFocus: () => opts.cardHadFocus ?? false,
      hideCard: () => log.push(['cardHidden', null]),
      hideBubble: () => log.push(['bubbleHidden', null]),
    },
    overlay: {
      toast: (_title, body) => log.push(['toast', body]),
      spawnMate: (p) => log.push(['ping', p]),
      toLocal: (p) => ({ displayId: 1, x: p.x / 2, y: p.y / 2 }),
    },
    glow: (box) => log.push(['glow', box]),
    zoneOffset: () => 0,
    now: () => clock,
    timer: (ms, fn) => {
      const timer = { at: clock + ms, fn, live: true };
      timers.push(timer);
      return () => {
        timer.live = false;
      };
    },
  };
  const runner = new ActionRunner(deps);
  const puts: unknown[] = [];
  runner.on('put', (s: unknown) => puts.push(s));

  const of = (kind: string): unknown[] => log.filter((e) => e[0] === kind).map((e) => e[1]);
  return {
    runner, log, of, puts,
    kinds: () => log.map((e) => e[0]),
    /** Moves the clock, firing each timer that comes due in order and letting what it starts settle. */
    advance: async (ms: number) => {
      const end = clock + ms;
      for (;;) {
        const due = timers.filter((x) => x.live && x.at <= end).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        due.live = false;
        clock = due.at;
        due.fn();
        await flush();
      }
      clock = end;
      await flush();
    },
  };
}

describe('ActionRunner', () => {
  it('copies a table as TSV and HTML and says its size', async () => {
    const h = harness();
    const rows = [['a', 'b', 'c', 'd'], ['1', '2', '3', '4'], ['5', '6', '7', '8']];
    h.runner.take(info(), { tool: 'copy', table: rows });
    await flush();
    expect(h.of('clip')).toEqual([{ text: tableTsv(rows), html: tableHtml(rows) }]);
    expect(h.of('toast')).toEqual([t.copiedTable(3, 4)]);
    h.runner.take(info(), { tool: 'copy', text: 'one\ntwo' });
    await flush();
    expect(h.of('clip')[1]).toEqual({ text: 'one\ntwo' });
    expect(h.of('toast')[1]).toBe(t.copiedText);
    // No consent for a copy.
    expect(h.of('consent')).toEqual([]);
    expect(h.runner.described()).toEqual([t.didCopyTable(3, 4), t.didCopyText(2)]);
  });

  it('asks before pasting and pastes after Allow once', async () => {
    const h = harness();
    h.runner.take(info(), paste());
    await flush();
    expect(h.of('paste')).toEqual([]);
    expect(h.of('consent')).toEqual([{
      at: { x: 500, y: 400 }, view: 'consent', lang: 'en', tag: TAG, action: 'paste', text: t.consentPaste('Chrome'),
      detail: 'Friday works.', always: true, seconds: 30,
    }]);
    expect(h.runner.putState).toBe('paste');

    h.runner.onAction('consent', { t: 'allow' });
    await flush();
    const req: PasteRequest = { window: ASK_WINDOW, text: 'Friday works.', click: null, mode: 'insert', asked: '' };
    expect(h.of('paste')).toEqual([req]);
    // The card is gone before the paste, so nothing of lolPing's is over the app.
    expect(h.kinds().indexOf('consentHidden')).toBeLessThan(h.kinds().indexOf('paste'));
    expect(h.of('toast')).toEqual([t.pasted]);
    expect(h.of('glow')).toEqual([REPLY_BOX]);
    expect(h.of('permissions')).toEqual([]);
    expect(h.runner.putState).toBeNull();
    expect(h.puts).toEqual(['paste', null]);
    expect(h.runner.described()).toEqual([t.didPaste(1, 'Chrome')]);
  });

  it('pastes without asking after Always allow and remembers it per profile', async () => {
    const h = harness();
    h.runner.take(info(), paste());
    await flush();
    h.runner.onAction('consent', { t: 'always' });
    await flush();
    expect(h.of('permissions')).toEqual([['fast:paste']]);
    expect(h.of('paste')).toHaveLength(1);

    h.runner.cancel();
    h.runner.take(info({ id: 'ask2' }), paste('Again.'));
    await flush();
    expect(h.of('consent')).toHaveLength(1);
    expect(h.of('paste')).toHaveLength(2);

    // Another profile asks for itself.
    h.runner.take(info({ id: 'ask3', profileId: 'deep' }), paste('Deep.'));
    await flush();
    expect(h.of('consent')).toHaveLength(2);
    expect(h.of('paste')).toHaveLength(2);
  });

  it('declines after 30 s and keeps the Paste button', async () => {
    const h = harness();
    h.runner.take(info({ selection: 'teh text' }), paste('the text', 'replace'));
    await flush();
    await h.advance(29_999);
    expect(h.of('consentHidden')).toEqual([]);
    await h.advance(1);
    expect(h.of('consentHidden')).toHaveLength(1);
    expect(h.of('paste')).toEqual([]);
    expect(h.runner.putState).toBe('replace');

    // The button's click is the consent: no second card.
    await h.runner.put(info({ selection: 'teh text' }), 'bubble');
    expect(h.of('consent')).toHaveLength(1);
    expect(h.of('paste')).toEqual([
      { window: ASK_WINDOW, text: 'the text', click: null, mode: 'replace', asked: 'teh text' },
    ]);
    expect(h.runner.putState).toBeNull();
  });

  it('refuses to paste into a secure field and copies instead', async () => {
    const h = harness({ permissions: ['fast:paste'] });
    h.runner.take(info({ focus: { label: 'Password', secure: true } }), paste('hunter2'));
    await flush();
    h.runner.take(info({ id: 'ask2', focus: { label: 'Card number', secure: false } }), paste('4111'));
    await flush();
    expect(h.of('paste')).toEqual([]);
    expect(h.of('clip')).toEqual([{ text: 'hunter2' }, { text: '4111' }]);
    expect(h.of('toast')).toEqual([t.pasteSecure, t.pasteSecure]);

    // The helper finds a password field the ask didn't see.
    const late = harness({ permissions: ['fast:paste'], pastes: [{ result: 'secure' }] });
    late.runner.take(info(), paste('x'));
    await flush();
    expect(late.of('clip')).toEqual([{ text: 'x' }]);
    expect(late.of('toast')).toEqual([t.pasteSecure]);
    expect(late.of('glow')).toEqual([]);
  });

  it('copies instead when the app is not responding', async () => {
    const h = harness({ permissions: ['fast:paste'], pastes: [{ result: 'hung' }] });
    h.runner.take(info(), paste('a\nb'));
    await flush();
    expect(h.of('paste')).toHaveLength(1);
    expect(h.of('clip')).toEqual([{ text: 'a\nb' }]);
    expect(h.of('toast')).toEqual([t.pasteHung('Chrome')]);
    expect(h.runner.described()).toEqual([t.didCopyText(2)]);
  });

  it('copies instead when the foreground window changed', async () => {
    const h = harness({ permissions: ['fast:paste'], foreground: ['999'] });
    h.runner.take(info(), paste());
    await flush();
    expect(h.of('paste')).toEqual([]);
    expect(h.of('clip')).toEqual([{ text: 'Friday works.' }]);
    expect(h.of('toast')).toEqual([t.pasteWindow]);

    // Or it changes after the check: the helper refuses.
    const late = harness({ permissions: ['fast:paste'], pastes: [{ result: 'window' }] });
    late.runner.take(info(), paste());
    await flush();
    expect(late.of('clip')).toEqual([{ text: 'Friday works.' }]);
    expect(late.of('toast')).toEqual([t.pasteWindow]);
  });

  it('waits for the ask window after closing the card', async () => {
    const h = harness({
      permissions: ['fast:paste'], cardHadFocus: true, foreground: ['card', 'card', 'card', ASK_WINDOW],
    });
    h.runner.take(info(), paste());
    await flush();
    expect(h.of('cardHidden')).toHaveLength(1);
    expect(h.of('paste')).toEqual([]);
    await h.advance(100);
    expect(h.of('paste')).toEqual([]);
    await h.advance(50);
    expect(h.of('paste')).toHaveLength(1);
    expect(h.of('toast')).toEqual([t.pasted]);

    // It never comes back: copy instead, after 500 ms.
    const gone = harness({ permissions: ['fast:paste'], cardHadFocus: true, foreground: ['card'] });
    gone.runner.take(info(), paste());
    await flush();
    await gone.advance(450);
    expect(gone.of('toast')).toEqual([]);
    await gone.advance(50);
    expect(gone.of('paste')).toEqual([]);
    expect(gone.of('clip')).toEqual([{ text: 'Friday works.' }]);
    expect(gone.of('toast')).toEqual([t.pasteWindow]);
  });

  it('shows Paste when ready when hands stayed on the keys', async () => {
    const h = harness({ permissions: ['fast:paste'], pastes: [{ result: 'hands' }, { result: 'ok' }] });
    h.runner.take(info(), paste());
    await flush();
    expect(h.runner.putState).toBe('ready');
    expect(h.of('clip')).toEqual([]);
    expect(h.of('toast')).toEqual([]);
    // Another ask's button does nothing here.
    await h.runner.put(info({ id: 'other' }), 'bubble');
    expect(h.of('paste')).toHaveLength(1);
    await h.runner.put(info(), 'bubble');
    expect(h.of('paste')).toHaveLength(2);
    expect(h.of('toast')).toEqual([t.pasted]);
    expect(h.runner.putState).toBeNull();
  });

  it('says so when the clipboard could not be put back', async () => {
    const h = harness({ permissions: ['fast:paste'], pastes: [{ result: 'ok', restored: false }] });
    h.runner.take(info(), paste());
    await flush();
    expect(h.of('toast')).toEqual([`${t.pasted} ${t.clipboardNotRestored}`]);
  });

  it('clicks the field under the spot only when nothing had the keyboard', async () => {
    const reply = field('9', 'Reply', { box: REPLY_BOX });
    const h = harness({ permissions: ['fast:paste'] });
    h.runner.take(info({ focus: null, fields: [reply] }), paste());
    await flush();
    expect(h.of('paste')).toEqual([
      { window: ASK_WINDOW, text: 'Friday works.', click: { x: 1100, y: 800 }, mode: 'insert', asked: '' },
    ]);
    // The bubble may be over the point: lolPing's own window there would make the helper refuse.
    expect(h.kinds().indexOf('bubbleHidden')).toBeLessThan(h.kinds().indexOf('paste'));
    h.runner.take(info({ id: 'ask2', fields: [reply] }), paste());
    await flush();
    expect((h.of('paste')[1] as PasteRequest).click).toBeNull();
  });

  it('always shows the form preview, even with Always allow', async () => {
    const h = harness({ permissions: ['fast:fill', 'fast:paste'] });
    h.runner.take(info({ fields: FIELDS }), {
      tool: 'fill',
      fields: [{ id: '1', value: 'Ada' }, { id: '2', value: 'ada@example.com' }, { id: '3', value: 'hunter2' }],
    });
    await flush();
    expect(h.of('setField')).toEqual([]);
    const form = h.of('form')[0] as FormState;
    expect(form).toMatchObject({ view: 'form', app: 'Chrome', tag: TAG });
    expect(form.rows.map((r) => [r.id, r.value])).toEqual([['1', 'Ada'], ['2', 'ada@example.com']]);
    expect(form.left).toEqual([{ label: 'Password', reason: 'secure' }]);
    expect(JSON.stringify(form)).not.toContain('hunter2');
    expect(h.runner.putState).toBe('fill');
  });

  it('fills checked rows and pings filled and left fields', async () => {
    const h = harness({ setField: { 4: 'refused' } });
    h.runner.take(info({ fields: FIELDS }), {
      tool: 'fill',
      fields: [{ id: '1', value: 'Ada' }, { id: '2', value: 'ada@example.com' }, { id: '4', value: 'Large' },
        { id: '3', value: 'hunter2' }],
    });
    await flush();
    // The user unchecked Email.
    h.runner.onAction('form', { t: 'fill', ids: ['1', '4'] });
    await flush();
    expect(h.of('formHidden')).toHaveLength(1);
    expect(h.of('setField')).toEqual([
      { window: ASK_WINDOW, field: '1', value: 'Ada' },
      { window: ASK_WINDOW, field: '4', value: 'Large' },
    ]);
    expect(h.of('paste')).toEqual([]); // a combo that refuses is left, never pasted into
    expect(h.of('ping')).toEqual([
      { displayId: 1, x: 100, y: 55, id: 'visioncleared', label: 'Name', tag: TAG },
      { displayId: 1, x: 100, y: 205, id: 'missing', label: 'Size', tag: TAG, silent: true },
      { displayId: 1, x: 100, y: 155, id: 'missing', label: 'Password', tag: TAG, silent: true },
    ]);
    expect(h.of('glow')).toEqual([FIELDS[0].box]);
    expect(h.of('toast')).toEqual([t.filled(1)]);
    expect(h.runner.described()).toEqual([t.didFill(1, 2)]);
    expect(h.runner.putState).toBeNull();
  });

  it('pastes into a refusing text field only with clipboardForForms on', async () => {
    const fill: ActionCall = { tool: 'fill', fields: [{ id: '1', value: 'Ada' }] };
    const off = harness({ setField: { 1: 'refused' } });
    off.runner.take(info({ fields: FIELDS }), fill);
    await flush();
    off.runner.onAction('form', { t: 'fill', ids: ['1'] });
    await flush();
    expect(off.of('paste')).toEqual([]);
    expect(off.of('ping')).toEqual([{ displayId: 1, x: 100, y: 55, id: 'missing', label: 'Name', tag: TAG }]);
    expect(off.of('toast')).toEqual([t.filledNone]);

    const on = harness({ setField: { 1: 'refused' }, clipboardForForms: true });
    on.runner.take(info({ fields: FIELDS }), fill);
    await flush();
    on.runner.onAction('form', { t: 'fill', ids: ['1'] });
    await flush();
    expect(on.of('paste')).toEqual([
      { window: ASK_WINDOW, text: 'Ada', click: { x: 200, y: 110 }, mode: 'insert', asked: '' },
    ]);
    expect(on.kinds().indexOf('bubbleHidden')).toBeLessThan(on.kinds().indexOf('paste'));
    expect(on.of('ping')).toEqual([{ displayId: 1, x: 100, y: 55, id: 'visioncleared', label: 'Name', tag: TAG }]);
    expect(on.of('toast')).toEqual([t.filled(1)]);
  });

  it('shows the event file in its folder when no calendar app opens it', async () => {
    const h = harness({ permissions: ['fast:event'], openPathError: 'No application is associated' });
    h.runner.take(info(), { tool: 'event', title: 'Dentist', start: '2026-11-05T15:00' });
    await flush();
    const [written] = h.of('writeFile') as { file: string; text: string }[];
    expect(written.file).toMatch(/^tmp[\\/].+\.ics$/);
    expect(written.text).toContain('SUMMARY:Dentist');
    expect(written.text).toContain('DTSTART:20261105T150000Z');
    expect(h.of('openPath')).toEqual([written.file]);
    expect(h.of('showInFolder')).toEqual([written.file]);
    expect(h.of('toast')).toEqual([t.eventOpenFile]);
    expect(h.runner.described()).toEqual([t.didEvent]);

    const opens = harness({ permissions: ['fast:event'] });
    opens.runner.take(info(), { tool: 'event', title: 'Dentist', start: '2026-11-05' });
    await flush();
    expect(opens.of('openPath')).toHaveLength(1);
    expect(opens.of('showInFolder')).toEqual([]);
    expect(opens.of('toast')).toEqual([]);
  });

  it('opens only after consent', async () => {
    const h = harness();
    h.runner.take(info(), { tool: 'open', url: 'https://Example.com/a b' });
    await flush();
    expect(h.of('openExternal')).toEqual([]);
    expect(h.of('consent')[0]).toMatchObject({
      action: 'open', text: t.consentOpen, detail: 'https://example.com/a%20b',
    });
    h.runner.onAction('consent', { t: 'decline' });
    await flush();
    expect(h.of('openExternal')).toEqual([]);

    h.runner.take(info({ id: 'ask2' }), { tool: 'open', url: 'https://Example.com/a b' });
    await flush();
    h.runner.onAction('consent', { t: 'allow' });
    await flush();
    expect(h.of('openExternal')).toEqual(['https://example.com/a%20b']);
    expect(h.runner.described()).toEqual([t.didOpen]);
  });

  it('shows one consent card at a time', async () => {
    const h = harness();
    h.runner.take(info(), paste());
    h.runner.take(info(), { tool: 'open', url: 'https://example.com/' });
    await flush();
    expect(h.of('consent')).toHaveLength(1);
    h.runner.onAction('consent', { t: 'allow' });
    await flush();
    expect(h.of('paste')).toHaveLength(1);
    expect((h.of('consent') as ConsentState[]).map((c) => c.action)).toEqual(['paste', 'open']);
    // An answer from the form preview does nothing while a consent card is up; this one is for the open.
    h.runner.onAction('form', { t: 'cancel' });
    h.runner.onAction('consent', { t: 'allow' });
    await flush();
    expect(h.of('openExternal')).toEqual(['https://example.com/']);
  });

  it('drops pending actions on a new ask', async () => {
    const h = harness();
    h.runner.take(info(), paste());
    h.runner.take(info(), { tool: 'open', url: 'https://example.com/' });
    await flush();
    h.runner.cancel();
    expect(h.of('consentHidden')).toHaveLength(1);
    expect(h.runner.putState).toBeNull();
    h.runner.onAction('consent', { t: 'allow' });
    await h.advance(30_000);
    expect(h.of('consent')).toHaveLength(1);
    expect(h.of('paste')).toEqual([]);
    expect(h.of('openExternal')).toEqual([]);
    await h.runner.put(info(), 'bubble');
    expect(h.of('paste')).toEqual([]);

    const form = harness();
    form.runner.take(info({ fields: FIELDS }), { tool: 'fill', fields: [{ id: '1', value: 'Ada' }] });
    await flush();
    form.runner.cancel();
    form.runner.onAction('form', { t: 'fill', ids: ['1'] });
    await flush();
    expect(form.of('formHidden')).toHaveLength(1);
    expect(form.of('setField')).toEqual([]);
  });
});

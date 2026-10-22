import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BubbleState, CardState, ConsentState, FormState, HistoryState, WordsState } from '../../../src/shared/teammateIpc';

type Rect = { x: number; y: number; width: number; height: number };

const h = vi.hoisted(() => ({
  windows: [] as Array<{
    opts: Record<string, unknown>;
    bounds: Rect;
    destroyed: boolean;
    visible: boolean;
    focused: number;
    contentProtection: boolean[];
    webContents: { send: ReturnType<typeof vi.fn>; emit: (e: string) => boolean };
    emit: (event: string) => boolean;
    close(): void;
  }>,
  handlers: new Map<string, (event: unknown, raw: unknown) => void>(),
  isMac: false,
  isLinux: false,
}));

vi.mock('electron', async () => {
  const { EventEmitter: Emitter } = await import('node:events');
  class FakeWindow extends Emitter {
    opts: Record<string, unknown>;
    bounds: Rect;
    destroyed = false;
    visible = false;
    focused = 0;
    contentProtection: boolean[] = [];
    webContents = Object.assign(new Emitter(), { send: vi.fn(), setWindowOpenHandler: vi.fn() });
    constructor(opts: Record<string, unknown>) {
      super();
      this.opts = opts;
      this.bounds = { x: Number(opts.x ?? 0), y: Number(opts.y ?? 0), width: Number(opts.width ?? 0), height: Number(opts.height ?? 0) };
      h.windows.push(this);
    }
    setContentProtection(on: boolean): void {
      this.contentProtection.push(on);
    }
    setAlwaysOnTop(): void {}
    setVisibleOnAllWorkspaces(): void {}
    setIgnoreMouseEvents(): void {}
    setBounds(r: Rect): void {
      this.bounds = r;
    }
    getBounds(): Rect {
      return this.bounds;
    }
    showInactive(): void {
      this.visible = true;
    }
    show(): void {
      this.visible = true;
    }
    focus(): void {
      this.focused++;
    }
    hide(): void {
      this.visible = false;
    }
    isVisible(): boolean {
      return this.visible;
    }
    removeMenu(): void {}
    isMinimized(): boolean {
      return false;
    }
    restore(): void {}
    isDestroyed(): boolean {
      return this.destroyed;
    }
    destroy(): void {
      if (this.destroyed) return;
      this.destroyed = true;
      this.emit('closed');
    }
    /** Like Electron, close() only asks: the window goes away (blur, then closed) a moment later. */
    close(): void {
      setTimeout(() => {
        this.emit('blur');
        this.destroy();
      }, 0);
    }
  }
  const screen = {
    getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1040 } }),
    getCursorScreenPoint: () => ({ x: 0, y: 0 }),
  };
  const ipcMain = {
    on: (channel: string, fn: (event: unknown, raw: unknown) => void) => h.handlers.set(channel, fn),
    removeListener: (channel: string) => h.handlers.delete(channel),
  };
  return { BrowserWindow: FakeWindow, ipcMain, nativeTheme: { shouldUseDarkColors: false }, screen };
});

vi.mock('../../../src/main/paths', () => ({
  get IS_MAC() {
    return h.isMac;
  },
  get IS_LINUX() {
    return h.isLinux;
  },
  loadPage: () => Promise.resolve(),
  pageUrl: (_page: string, hash = '') => `lolping://app/teammate/index.html${hash ? `#${hash}` : ''}`,
  preloadPath: () => 'preload.js',
}));

const tag = { name: 'Mate', color: 3 };
const bubble: BubbleState = { view: 'bubble', lang: 'en', tag, line: 'It is a typo.', thread: null, thinking: false, more: true };
const card: CardState = {
  view: 'card', lang: 'en', tag, title: 'Typo', entries: [{ kind: 'answer', label: 'Mate', markdown: '**typo**' }],
  streaming: false, footer: { profile: 'Default', model: 'm', tokens: null, used: [] },
};
const words: WordsState = { view: 'words', lang: 'en', tag, thread: null, continueByDefault: false };
const consent: ConsentState = {
  view: 'consent', lang: 'en', tag, action: 'paste', text: 'Paste this into Chrome?', detail: 'Hello there', always: true, seconds: 30,
};
const form: FormState = {
  view: 'form', lang: 'en', tag, app: 'Chrome',
  rows: [
    { id: 'f1', label: 'Name', value: 'Ada Lovelace', checked: true },
    { id: 'f2', label: 'Email', value: 'ada@example.com', checked: true },
  ],
  left: [{ label: 'Password', reason: 'secure' }],
};
const history: HistoryState = { view: 'history', lang: 'en', available: true, query: '', threads: [] };

type Mod = typeof import('../../../src/main/teammate/mateWindows');
let mod: Mod;
let mate: InstanceType<Mod['MateWindows']>;
let actions: unknown[];

const sendAction = (i: number, raw: unknown): void => h.handlers.get('mate:action')?.({ sender: h.windows[i].webContents }, raw);

beforeEach(async () => {
  h.windows.length = 0;
  h.handlers.clear();
  h.isMac = false;
  h.isLinux = false;
  vi.resetModules();
  mod = await import('../../../src/main/teammate/mateWindows');
  mate = new mod.MateWindows();
  actions = [];
  mate.on('action', (a) => actions.push(a));
});

describe('MateWindows', () => {
  it('passes on only the actions the sending window may ask for', () => {
    mate.showBubble({ x: 10, y: 10 }, bubble);
    mate.showWords({ x: 10, y: 10 }, words);
    sendAction(0, { t: 'more' });
    sendAction(0, { t: 'ask', text: 'hi', newThread: false });
    sendAction(1, { t: 'ask', text: 'hi', newThread: false });
    h.handlers.get('mate:action')?.({ sender: {} }, { t: 'more' });
    expect(actions).toEqual([
      { view: 'bubble', action: { t: 'more' } },
      { view: 'words', action: { t: 'ask', text: 'hi', newThread: false } },
    ]);
  });

  it('never lets the bubble take focus, and lets the card take it only when clicked', () => {
    mate.showBubble({ x: 10, y: 10 }, bubble);
    mate.showCard({ x: 10, y: 10 }, card);
    for (const w of h.windows) w.webContents.emit('did-finish-load');
    expect(h.windows[0].opts.focusable).toBe(false);
    expect(h.windows[1].opts.focusable).toBe(true);
    expect(h.windows.map((w) => [w.visible, w.focused])).toEqual([[true, 0], [true, 0]]);
  });

  it('keeps a window inside the work area', () => {
    mate.showBubble({ x: 1900, y: 1030 }, bubble);
    const b = h.windows[0].bounds;
    expect(b.x + b.width).toBeLessThanOrEqual(1920);
    expect(b.y + b.height).toBeLessThanOrEqual(1040);
  });

  it('cancels the words box when it loses focus, and closes it', async () => {
    mate.showWords({ x: 10, y: 10 }, words);
    const w = h.windows[0];
    w.emit('focus');
    w.emit('blur');
    expect(actions).toEqual([{ view: 'words', action: { t: 'cancel' } }]);
    await vi.waitFor(() => expect(w.destroyed).toBe(true));
    expect(actions).toHaveLength(1);
  });

  it('replaces an open words box with a fresh one at the new spot, cancelling the old ask', async () => {
    mate.showWords({ x: 10, y: 10 }, words);
    const a = h.windows[0];
    a.emit('focus');
    const second: WordsState = { ...words, thread: 'Invoice' };
    mate.showWords({ x: 900, y: 500 }, second);
    expect(actions).toEqual([{ view: 'words', action: { t: 'cancel' } }]);
    const b = h.windows[1];
    expect(b).toBeDefined();
    expect(b.bounds).toMatchObject({ x: 900, y: 500 });
    b.webContents.emit('did-finish-load');
    expect(b.webContents.send).toHaveBeenCalledWith('mate:state', second);
    b.emit('focus');
    await vi.waitFor(() => expect(a.destroyed).toBe(true)); // the old box's blur and close don't touch the new one
    sendAction(0, { t: 'ask', text: 'old', newThread: false });
    sendAction(1, { t: 'ask', text: 'new', newThread: false });
    expect(actions).toEqual([
      { view: 'words', action: { t: 'cancel' } },
      { view: 'words', action: { t: 'ask', text: 'new', newThread: false } },
    ]);
  });

  it('opens a new words box when shown again before the hidden one has closed', async () => {
    mate.showWords({ x: 10, y: 10 }, words);
    const a = h.windows[0];
    a.emit('focus');
    mate.hideWords();
    mate.showWords({ x: 300, y: 300 }, words);
    const b = h.windows[1];
    expect(b).toBeDefined();
    b.emit('focus');
    await vi.waitFor(() => expect(a.destroyed).toBe(true));
    expect(b.destroyed).toBe(false);
    sendAction(1, { t: 'ask', text: 'hi', newThread: true });
    expect(actions).toEqual([{ view: 'words', action: { t: 'ask', text: 'hi', newThread: true } }]);
  });

  it('resizes a window to the size its page reports, within its view limits', () => {
    mate.showCard({ x: 100, y: 100 }, card);
    h.handlers.get('mate:size')?.({ sender: h.windows[0].webContents }, { width: 2000, height: 300 });
    expect(h.windows[0].bounds).toMatchObject({ width: 480, height: 300 });
  });

  it('opens the history as a normal window and sends its state', () => {
    mate.showHistory(history);
    const w = h.windows[0];
    expect(w.opts.frame).not.toBe(false);
    w.webContents.emit('did-finish-load');
    expect(w.webContents.send).toHaveBeenCalledWith('mate:state', history);
    sendAction(0, { t: 'search', query: 'abc' });
    expect(actions).toEqual([{ view: 'history', action: { t: 'search', query: 'abc' } }]);
  });
});

describe('MateWindows consent card', () => {
  const openConsent = (state: ConsentState = consent, at = { x: 500, y: 400 }): (typeof h.windows)[number] => {
    mate.showConsent(at, state);
    const w = h.windows[h.windows.length - 1];
    w.webContents.emit('did-finish-load');
    return w;
  };

  it('shows the consent card without taking focus', () => {
    const w = openConsent();
    expect(w.opts.focusable).toBe(false);
    expect(w.visible).toBe(true);
    expect(w.focused).toBe(0);
  });

  it('places the card beside the spot and tells the page which side it is on', () => {
    const w = openConsent();
    expect(w.bounds.x).toBeGreaterThan(500);
    expect(w.bounds.y + w.bounds.height / 2).toBeCloseTo(400, -1);
    expect(w.webContents.send).toHaveBeenCalledWith('mate:state', { ...consent, side: 'right', serial: 1 });
    const far = openConsent(consent, { x: 1900, y: 400 });
    expect(far.bounds.x + far.bounds.width).toBeLessThanOrEqual(1900);
    expect(far.webContents.send).toHaveBeenCalledWith('mate:state', { ...consent, side: 'left', serial: 2 });
  });

  it('passes on allow, always and decline, once per card', () => {
    openConsent();
    sendAction(0, { t: 'more' });
    sendAction(0, { t: 'allow' });
    sendAction(0, { t: 'allow' });
    sendAction(0, { t: 'decline' });
    expect(actions).toEqual([{ view: 'consent', action: { t: 'allow' } }]);
    mate.showConsent({ x: 500, y: 400 }, consent);
    sendAction(0, { t: 'always' });
    expect(actions).toHaveLength(2);
    expect(actions[1]).toEqual({ view: 'consent', action: { t: 'always' } });
  });

  it('refuses Always allow when the card did not offer it', () => {
    openConsent({ ...consent, action: 'fill', always: false });
    sendAction(0, { t: 'always' });
    expect(actions).toEqual([]);
    sendAction(0, { t: 'allow' });
    expect(actions).toEqual([{ view: 'consent', action: { t: 'allow' } }]);
  });

  it('updates the card in place and hides it without closing it', async () => {
    vi.useFakeTimers();
    try {
      const w = openConsent();
      mate.updateConsent({ ...consent, detail: 'Changed' });
      expect(w.webContents.send).toHaveBeenLastCalledWith('mate:state', { ...consent, detail: 'Changed', side: 'right', serial: 1 });
      mate.hideConsent();
      await vi.advanceTimersByTimeAsync(1000);
      expect(w.visible).toBe(false);
      expect(w.destroyed).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignores a click on a card that was hidden, and takes clicks again on the next one', async () => {
    vi.useFakeTimers();
    try {
      const w = openConsent();
      mate.hideConsent();
      await vi.advanceTimersByTimeAsync(100); // inside the leave motion
      sendAction(0, { t: 'allow' });
      expect(actions).toEqual([]);
      await vi.advanceTimersByTimeAsync(1000);
      mate.showConsent({ x: 500, y: 400 }, consent);
      expect(w.visible).toBe(true);
      sendAction(0, { t: 'allow' });
      expect(actions).toEqual([{ view: 'consent', action: { t: 'allow' } }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('gives every shown card a new serial, and keeps it for updates, so the page restarts only for a new card', () => {
    const w = openConsent();
    mate.showConsent({ x: 500, y: 400 }, { ...consent, detail: 'Second' });
    mate.updateConsent({ ...consent, detail: 'Second, changed' });
    const serials = w.webContents.send.mock.calls.map(([, state]) => (state as ConsentState).serial);
    expect(serials).toEqual([1, 2, 2]);
  });

  it('resizes to the height the page reports and keeps the card beside the spot', () => {
    const w = openConsent();
    h.handlers.get('mate:size')?.({ sender: w.webContents }, { width: 384, height: 260 });
    expect(w.bounds).toMatchObject({ width: 384, height: 260 });
    expect(w.bounds.y + 130).toBeCloseTo(400, -1);
  });
});

describe('MateWindows form preview', () => {
  const openForm = (state: FormState = form, at = { x: 500, y: 400 }): (typeof h.windows)[number] => {
    mate.showForm(at, state);
    const w = h.windows[h.windows.length - 1];
    w.webContents.emit('did-finish-load');
    return w;
  };

  it('shows the form preview without taking focus', () => {
    const w = openForm();
    expect(w.opts.focusable).toBe(false);
    expect(w.visible).toBe(true);
    expect(w.focused).toBe(0);
  });

  it('places the preview beside the spot and tells the page which side it is on', () => {
    const w = openForm();
    expect(w.bounds.x).toBeGreaterThan(500);
    expect(w.webContents.send).toHaveBeenCalledWith('mate:state', { ...form, side: 'right', serial: 1 });
    const far = openForm(form, { x: 1900, y: 400 });
    expect(far.bounds.x + far.bounds.width).toBeLessThanOrEqual(1900);
    expect(far.webContents.send).toHaveBeenCalledWith('mate:state', { ...form, side: 'left', serial: 2 });
  });

  it('counts its serials apart from the consent card, so showing one never restarts the other', () => {
    mate.showConsent({ x: 500, y: 400 }, consent);
    const card = h.windows[h.windows.length - 1];
    card.webContents.emit('did-finish-load');
    const w = openForm();
    mate.updateConsent({ ...consent, detail: 'Changed' });
    expect(w.webContents.send).toHaveBeenCalledWith('mate:state', { ...form, side: 'right', serial: 1 });
    expect(card.webContents.send).toHaveBeenLastCalledWith(
      'mate:state', { ...consent, detail: 'Changed', side: 'right', serial: 1 },
    );
  });

  it('passes on a fill of listed rows once, with each id once', () => {
    openForm();
    sendAction(0, { t: 'fill', ids: ['f2', 'f1', 'f2'] });
    sendAction(0, { t: 'fill', ids: ['f1'] });
    sendAction(0, { t: 'cancel' });
    expect(actions).toEqual([{ view: 'form', action: { t: 'fill', ids: ['f2', 'f1'] } }]);
  });

  it('drops a fill that names a field the preview did not list, and keeps waiting for the user', () => {
    openForm();
    sendAction(0, { t: 'fill', ids: ['f1', 'f9'] });
    sendAction(0, { t: 'fill', ids: ['f9'] });
    expect(actions).toEqual([]);
    sendAction(0, { t: 'fill', ids: ['f1'] });
    expect(actions).toEqual([{ view: 'form', action: { t: 'fill', ids: ['f1'] } }]);
  });

  it('takes the listed rows from the latest state it sent', () => {
    openForm();
    mate.updateForm({ ...form, rows: [{ id: 'f3', label: 'Phone', value: '555', checked: true }] });
    sendAction(0, { t: 'fill', ids: ['f1'] });
    expect(actions).toEqual([]);
    sendAction(0, { t: 'fill', ids: ['f3'] });
    expect(actions).toEqual([{ view: 'form', action: { t: 'fill', ids: ['f3'] } }]);
  });

  it('passes on a cancel once, and takes a decision again for the next preview', () => {
    openForm();
    sendAction(0, { t: 'cancel' });
    sendAction(0, { t: 'fill', ids: ['f1'] });
    expect(actions).toEqual([{ view: 'form', action: { t: 'cancel' } }]);
    mate.showForm({ x: 500, y: 400 }, form);
    sendAction(0, { t: 'fill', ids: ['f1'] });
    expect(actions).toHaveLength(2);
  });

  it('ignores a click on a preview that was hidden', async () => {
    vi.useFakeTimers();
    try {
      const w = openForm();
      mate.hideForm();
      await vi.advanceTimersByTimeAsync(100); // inside the leave motion
      sendAction(0, { t: 'fill', ids: ['f1'] });
      expect(actions).toEqual([]);
      await vi.advanceTimersByTimeAsync(1000);
      expect(w.visible).toBe(false);
      expect(w.destroyed).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('grows with the page up to 420 by 520 and keeps the preview beside the spot', () => {
    const w = openForm();
    const size = h.handlers.get('mate:size');
    size?.({ sender: w.webContents }, { width: 420, height: 380 });
    expect(w.bounds).toMatchObject({ width: 420, height: 380 });
    expect(w.bounds.y + 190).toBeCloseTo(400, -1);
    size?.({ sender: w.webContents }, { width: 900, height: 2000 });
    expect(w.bounds).toMatchObject({ width: 420, height: 520 });
  });
});

describe('MateWindows card focus', () => {
  const openCard = (): (typeof h.windows)[number] => {
    mate.showCard({ x: 10, y: 10 }, card);
    const w = h.windows[h.windows.length - 1];
    w.webContents.emit('did-finish-load');
    return w;
  };

  it('closes a card that had focus instead of hiding it', async () => {
    vi.useFakeTimers();
    try {
      const w = openCard();
      w.emit('focus');
      mate.hideCard();
      expect(mate.cardHadFocus()).toBe(true);
      await vi.advanceTimersByTimeAsync(1000);
      expect(w.destroyed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('hides a card that never had focus', async () => {
    vi.useFakeTimers();
    try {
      const w = openCard();
      mate.hideCard();
      expect(mate.cardHadFocus()).toBe(false);
      await vi.advanceTimersByTimeAsync(1000);
      expect(w.destroyed).toBe(false);
      expect(w.visible).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('opens a fresh card after one was closed', async () => {
    vi.useFakeTimers();
    try {
      const first = openCard();
      first.emit('focus');
      mate.hideCard();
      await vi.advanceTimersByTimeAsync(1000);
      expect(first.destroyed).toBe(true);
      const second = openCard();
      expect(second).not.toBe(first);
      expect(second.visible).toBe(true);
      expect(second.destroyed).toBe(false);
      expect(mate.cardHadFocus()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the focus note when the card is shown again during its leave motion', async () => {
    vi.useFakeTimers();
    try {
      const w = openCard();
      w.emit('focus');
      mate.hideCard();
      await vi.advanceTimersByTimeAsync(100);
      mate.showCard({ x: 10, y: 10 }, card);
      expect(h.windows).toHaveLength(1);
      expect(mate.cardHadFocus()).toBe(true);
      mate.hideCard();
      await vi.advanceTimersByTimeAsync(1000);
      expect(w.destroyed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps a card opened while the focused one is still closing', async () => {
    vi.useFakeTimers();
    try {
      const first = openCard();
      first.emit('focus');
      mate.hideCard();
      await vi.advanceTimersByTimeAsync(200); // the leave motion is over, close() has only been asked for
      const second = openCard();
      await vi.advanceTimersByTimeAsync(1000);
      expect(first.destroyed).toBe(true);
      expect(second.destroyed).toBe(false);
      expect(second.visible).toBe(true);
      expect(mate.cardHadFocus()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('MateWindows capture exclusion', () => {
  it('keeps every teammate window out of a capture on Windows and lets them back in after', () => {
    mate.showBubble({ x: 10, y: 10 }, bubble);
    mate.showCard({ x: 10, y: 10 }, card);
    mate.setCaptureExcluded(true);
    expect(h.windows.map((w) => w.contentProtection)).toEqual([[true], [true]]);
    mate.setCaptureExcluded(false);
    expect(h.windows.map((w) => w.contentProtection)).toEqual([[true, false], [true, false]]);
  });

  it('excludes a teammate window opened mid-capture', () => {
    mate.setCaptureExcluded(true);
    mate.showWords({ x: 10, y: 10 }, words);
    expect(h.windows[0].contentProtection).toEqual([true]);
  });

  it('leaves the windows alone on macOS, whose capture leaves lolPing out by itself', async () => {
    h.isMac = true;
    vi.resetModules();
    const { MateWindows } = await import('../../../src/main/teammate/mateWindows');
    const mac = new MateWindows();
    mac.showBubble({ x: 10, y: 10 }, bubble);
    mac.setCaptureExcluded(true);
    expect(h.windows.at(-1)?.contentProtection).toEqual([]);
    expect(h.windows.at(-1)?.opts.type).toBe('panel');
  });
});

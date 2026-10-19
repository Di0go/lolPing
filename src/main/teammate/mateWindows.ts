import { BrowserWindow, ipcMain, nativeTheme, screen, type BrowserWindowConstructorOptions, type IpcMainEvent } from 'electron';
import { EventEmitter } from 'node:events';
import {
  parseMateAction, parseMateSize, TEAMMATE_CH, type BubbleState, type CardState, type HistoryState, type MateAction,
  type MateLeave, type MateState, type MateView, type WordsState,
} from '../../shared/teammateIpc';
import { placeInside } from '../coords';
import { IS_LINUX, IS_MAC, loadPage, pageUrl, preloadPath } from '../paths';

type Point = { x: number; y: number };
type Size = { width: number; height: number };

const VIEWS: readonly MateView[] = ['bubble', 'card', 'words', 'history'];
/** First size of each window in DIPs; the bubble and the card then take the size their page reports. */
const START_SIZE: Record<MateView, Size> = {
  bubble: { width: 360, height: 72 },
  card: { width: 480, height: 240 },
  words: { width: 460, height: 112 },
  history: { width: 760, height: 600 },
};
/** Long enough for the page's leave animation (150 ms, or the 600 ms stale fade) to finish before the window hides. */
const LEAVE_MS: Record<MateLeave, number> = { fast: 170, stale: 620 };
/** If the words box has no keyboard focus by then, it cancels instead of sitting there (as the text box does). */
const FOCUS_WAIT_MS = 2000;

interface Slot {
  win: BrowserWindow | null;
  loaded: boolean;
  /** The latest state; sent as soon as the page has loaded, and again by an update. */
  state: MateState | null;
  /** The window should be on screen: it shows once its page has loaded. */
  shown: boolean;
  at: Point;
  size: Size;
  /** The words box has asked or cancelled: nothing more comes from it. */
  ended: boolean;
  leaveTimer: ReturnType<typeof setTimeout> | null;
}

const emptySlot = (view: MateView): Slot => ({
  win: null, loaded: false, state: null, shown: false, at: { x: 0, y: 0 }, size: { ...START_SIZE[view] }, ended: false,
  leaveTimer: null,
});

/**
 * The teammate's windows. The bubble takes clicks without focus; the card takes focus only when clicked, so the app
 * underneath keeps the keyboard until the user replies; the words box takes focus and gives it back when it closes;
 * History is a normal window. Emits 'action' with `{ view, action }`, already validated for that view. It only shows
 * state and passes actions on: what an action does is up to the caller.
 */
export class MateWindows extends EventEmitter {
  private readonly slots: Record<MateView, Slot> = {
    bubble: emptySlot('bubble'), card: emptySlot('card'), words: emptySlot('words'), history: emptySlot('history'),
  };
  private captureExcluded = false;

  constructor() {
    super();
    ipcMain.on(TEAMMATE_CH.action, this.onAction);
    ipcMain.on(TEAMMATE_CH.size, this.onSize);
  }

  /** `at` is a screen point in DIPs: the bubble's top-left, kept inside that display's work area. */
  showBubble(at: Point, s: BubbleState): void {
    this.showPopup('bubble', at, s);
  }

  updateBubble(s: BubbleState): void {
    this.update('bubble', s);
  }

  /** `stale`: the slow fade for a signal that went stale, instead of the quick close. */
  hideBubble(opts: { stale?: boolean } = {}): void {
    this.leave('bubble', opts.stale ? 'stale' : 'fast');
  }

  showCard(at: Point, s: CardState): void {
    this.showPopup('card', at, s);
  }

  updateCard(s: CardState): void {
    this.update('card', s);
  }

  hideCard(): void {
    this.leave('card', 'fast');
  }

  showWords(at: Point, s: WordsState): void {
    const slot = this.slots.words;
    if (slot.win && !slot.win.isDestroyed()) {
      slot.win.show();
      slot.win.focus();
      return;
    }
    Object.assign(slot, emptySlot('words'), { at, state: s, shown: true });
    const w = this.create('words', slot, { focusable: true, ...this.popupOptions() });
    w.setAlwaysOnTop(true, 'screen-saver');
    let focused = false;
    w.on('focus', () => {
      focused = true;
    });
    // Clicking away cancels. Not before the box has had focus once, or showing it would close it.
    w.on('blur', () => {
      if (focused) this.endWords({ t: 'cancel' });
    });
    setTimeout(() => {
      if (!w.isDestroyed() && !focused) this.endWords({ t: 'cancel' });
    }, FOCUS_WAIT_MS);
    w.once('ready-to-show', () => {
      w.show();
      w.focus();
    });
  }

  /** Closes the words box without an action; closing it hands the keyboard back to the window it was opened over. */
  hideWords(): void {
    const slot = this.slots.words;
    slot.ended = true;
    if (slot.win && !slot.win.isDestroyed()) slot.win.close();
  }

  showHistory(s: HistoryState): void {
    const slot = this.slots.history;
    slot.state = s;
    slot.shown = true;
    if (slot.win && !slot.win.isDestroyed()) {
      this.push(slot);
      if (slot.win.isMinimized()) slot.win.restore();
      slot.win.show();
      slot.win.focus();
      return;
    }
    const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
    slot.at = { x: area.x + (area.width - slot.size.width) / 2, y: area.y + (area.height - slot.size.height) / 2 };
    const w = this.create('history', slot, {
      minWidth: 480,
      minHeight: 360,
      autoHideMenuBar: true,
      // The page's own background, so the window doesn't flash white before it loads in dark mode.
      backgroundColor: nativeTheme.shouldUseDarkColors ? '#1f1f1f' : '#fafafa',
    });
    w.removeMenu();
    w.once('ready-to-show', () => {
      w.show();
      w.focus();
    });
  }

  updateHistory(s: HistoryState): void {
    this.update('history', s);
  }

  /**
   * While a capture runs, every teammate window is left out of the picture, so the model never sees its own
   * bubble. Windows only: the macOS capture leaves lolPing's windows out by itself.
   */
  setCaptureExcluded(on: boolean): void {
    if (IS_MAC || IS_LINUX) return;
    this.captureExcluded = on;
    for (const view of VIEWS) {
      const w = this.slots[view].win;
      if (w && !w.isDestroyed()) w.setContentProtection(on);
    }
  }

  destroy(): void {
    ipcMain.removeListener(TEAMMATE_CH.action, this.onAction);
    ipcMain.removeListener(TEAMMATE_CH.size, this.onSize);
    for (const view of VIEWS) {
      const slot = this.slots[view];
      if (slot.leaveTimer) clearTimeout(slot.leaveTimer);
      slot.ended = true;
      const w = slot.win;
      this.slots[view] = emptySlot(view);
      if (w && !w.isDestroyed()) w.destroy();
    }
  }

  private showPopup(view: 'bubble' | 'card', at: Point, s: MateState): void {
    const slot = this.slots[view];
    if (slot.leaveTimer) clearTimeout(slot.leaveTimer);
    slot.leaveTimer = null;
    slot.state = s;
    slot.shown = true;
    slot.at = at;
    const w = slot.win && !slot.win.isDestroyed()
      ? slot.win
      // The card can be clicked into for the reply box; the bubble never takes the keyboard.
      : this.create(view, slot, { focusable: view === 'card', ...this.popupOptions() });
    w.setBounds(this.rect(slot));
    if (!slot.loaded) return; // 'did-finish-load' sends the state and shows the window
    this.push(slot);
    this.reveal(w);
  }

  private popupOptions(): BrowserWindowConstructorOptions {
    return {
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      hasShadow: false,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      // macOS: a non-activating panel keeps the app underneath active. Not checked on a Mac yet.
      ...(IS_MAC ? { type: 'panel' as const } : {}),
    };
  }

  private update(view: MateView, s: MateState): void {
    const slot = this.slots[view];
    if (!slot.shown) return;
    slot.state = s;
    this.push(slot);
  }

  private leave(view: 'bubble' | 'card', how: MateLeave): void {
    const slot = this.slots[view];
    if (!slot.shown) return;
    slot.shown = false;
    const w = slot.win;
    if (!w || w.isDestroyed()) return;
    if (!slot.loaded) return void w.hide();
    w.webContents.send(TEAMMATE_CH.leave, how);
    if (slot.leaveTimer) clearTimeout(slot.leaveTimer);
    slot.leaveTimer = setTimeout(() => {
      slot.leaveTimer = null;
      if (!slot.shown && !w.isDestroyed()) w.hide();
    }, LEAVE_MS[how]);
  }

  private endWords(action: MateAction): void {
    const slot = this.slots.words;
    if (slot.ended) return;
    slot.ended = true;
    this.emit('action', { view: 'words', action });
    if (slot.win && !slot.win.isDestroyed()) slot.win.close();
  }

  private rect(slot: Slot): { x: number; y: number; width: number; height: number } {
    const area = screen.getDisplayNearestPoint(slot.at).workArea;
    return { ...placeInside(slot.at, slot.size, area), ...slot.size };
  }

  private push(slot: Slot): void {
    if (slot.win && !slot.win.isDestroyed() && slot.loaded && slot.state) slot.win.webContents.send(TEAMMATE_CH.state, slot.state);
  }

  private reveal(w: BrowserWindow): void {
    // Windows can drop an always-on-top window behind normal ones after a while (#70): set the level again each time.
    w.setAlwaysOnTop(true, 'screen-saver');
    w.showInactive();
  }

  private create(view: MateView, slot: Slot, opts: BrowserWindowConstructorOptions): BrowserWindow {
    const w = new BrowserWindow({
      ...this.rect(slot),
      show: false,
      ...opts,
      webPreferences: { preload: preloadPath('teammate'), spellcheck: false },
    });
    slot.win = w;
    slot.loaded = false;
    if (this.captureExcluded) w.setContentProtection(true);
    if (view === 'bubble' || view === 'card') {
      w.setAlwaysOnTop(true, 'screen-saver'); // above the overlay and a game's borderless window
      if (IS_LINUX) w.setVisibleOnAllWorkspaces(true);
      if (IS_MAC) w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
    }
    w.on('closed', () => {
      if (slot.leaveTimer) clearTimeout(slot.leaveTimer);
      if (view === 'words' && !slot.ended) {
        slot.ended = true;
        this.emit('action', { view, action: { t: 'cancel' } });
      }
      if (slot.win === w) this.slots[view] = emptySlot(view);
    });
    w.webContents.on('did-finish-load', () => {
      slot.loaded = true;
      if (view === 'words' || view === 'history') return this.push(slot); // shown on 'ready-to-show'
      if (!slot.shown) return;
      this.push(slot);
      this.reveal(w);
    });
    const drop = (): void => {
      if (!w.isDestroyed()) w.destroy();
    };
    w.webContents.on('did-fail-load', drop);
    w.webContents.on('render-process-gone', drop);
    const own = new URL(pageUrl('teammate'));
    w.webContents.on('will-navigate', (event) => {
      try {
        const target = new URL(event.url);
        if (target.protocol !== own.protocol || target.host !== own.host || target.pathname !== own.pathname) event.preventDefault();
      } catch {
        event.preventDefault();
      }
    });
    w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    loadPage(w, 'teammate', view).catch(drop);
    return w;
  }

  private viewOf(event: IpcMainEvent): MateView | undefined {
    return VIEWS.find((v) => {
      const w = this.slots[v].win;
      return w !== null && !w.isDestroyed() && w.webContents === event.sender;
    });
  }

  private readonly onAction = (event: IpcMainEvent, raw: unknown): void => {
    const view = this.viewOf(event);
    if (!view) return;
    const action = parseMateAction(raw, view);
    if (!action) return;
    // The words box's job ends with an ask or a cancel: it closes, and the keyboard goes back where it was.
    if (view === 'words') return this.endWords(action);
    this.emit('action', { view, action });
  };

  private readonly onSize = (event: IpcMainEvent, raw: unknown): void => {
    const view = this.viewOf(event);
    if (!view) return;
    const size = parseMateSize(raw, view);
    const slot = this.slots[view];
    if (!size || !slot.win) return;
    slot.size = size;
    slot.win.setBounds(this.rect(slot));
  };
}

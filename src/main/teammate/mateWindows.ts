import { BrowserWindow, ipcMain, nativeTheme, screen, type BrowserWindowConstructorOptions, type IpcMainEvent } from 'electron';
import { EventEmitter } from 'node:events';
import {
  parseMateAction, parseMateDrag, parseMateSize, TEAMMATE_CH, type BubbleState, type CardState, type ConsentState, type FormState,
  type HistoryState, type MateAction, type MateLeave, type MateState, type MateView, type WordsState,
} from '../../shared/teammateIpc';
import { besideSpot, placeInside } from '../coords';
import { IS_LINUX, IS_MAC, loadPage, pageUrl, preloadPath } from '../paths';

type Point = { x: number; y: number };
type Size = { width: number; height: number };

/** What `overShownWindow` reads of a window. */
export type ShownWindow = Pick<BrowserWindow, 'isDestroyed' | 'isVisible' | 'isMinimized' | 'getBounds'>;

/** Whether a screen point in DIPs is over one of `wins` that is on screen: lolPing's own windows for the stale watch. */
export function overShownWindow(dip: Point, wins: readonly (ShownWindow | null)[]): boolean {
  return wins.some((w) => {
    if (!w || w.isDestroyed() || !w.isVisible() || w.isMinimized()) return false;
    const b = w.getBounds();
    return dip.x >= b.x && dip.x < b.x + b.width && dip.y >= b.y && dip.y < b.y + b.height;
  });
}

const VIEWS: readonly MateView[] = ['bubble', 'card', 'words', 'history', 'consent', 'form'];
/** First size of each window in DIPs; the bubble and the card then take the size their page reports. */
const START_SIZE: Record<MateView, Size> = {
  bubble: { width: 360, height: 72 },
  card: { width: 480, height: 240 },
  words: { width: 460, height: 112 },
  history: { width: 760, height: 600 },
  consent: { width: 384, height: 220 },
  form: { width: 420, height: 300 },
};
/** Long enough for the page's leave animation (150 ms, or the 600 ms stale fade) to finish before the window hides. */
const LEAVE_MS: Record<MateLeave, number> = { fast: 170, stale: 620 };
/** If the words box has no keyboard focus by then, it cancels instead of sitting there (as the text box does). */
const FOCUS_WAIT_MS = 2000;
/** The words box's ask waits this long at most for the box to close and hand the keyboard back. */
const CLOSE_WAIT_MS = 500;

interface Slot {
  view: MateView;
  win: BrowserWindow | null;
  loaded: boolean;
  /** The latest state; sent as soon as the page has loaded, and again by an update. */
  state: MateState | null;
  /** The window should be on screen: it shows once its page has loaded. */
  shown: boolean;
  at: Point;
  size: Size;
  /** The words box has asked or cancelled, or the consent card or form preview has decided: nothing more comes. */
  ended: boolean;
  leaveTimer: ReturnType<typeof setTimeout> | null;
  /** The card has had keyboard focus: hiding it would keep the foreground, so it is closed instead. */
  hadFocus: boolean;
  /** The rows of the form preview last sent: a fill may name only these. */
  formIds: ReadonlySet<string>;
  /** The card opens with the keyboard: the user asked for it (More), so Esc and the reply box work at once. */
  focusOnShow: boolean;
  /** Where the window was when the user started dragging it; null when no drag is on. */
  dragFrom: Point | null;
  /** Sends the words box's ask, which waits for the box to close; null when none is waiting. */
  sendAsk: (() => void) | null;
}

const emptySlot = (view: MateView): Slot => ({
  view, win: null, loaded: false, state: null, shown: false, at: { x: 0, y: 0 }, size: { ...START_SIZE[view] }, ended: false,
  leaveTimer: null, hadFocus: false, formIds: new Set(), focusOnShow: false,
  dragFrom: null, sendAsk: null,
});

/**
 * The teammate's windows. The bubble takes clicks without focus; the card takes focus only when clicked, so the app
 * underneath keeps the keyboard until the user replies; the words box takes focus and gives it back when it closes;
 * History is a normal window; the consent card and the form preview never take focus, as the bubble. Emits
 * 'action' with `{ view, action }`, already validated for that view, and 'dragged' with the view the user moved. It
 * only shows state and passes actions on: what an action does is up to the caller.
 */
export class MateWindows extends EventEmitter {
  private readonly slots: Record<MateView, Slot> = {
    bubble: emptySlot('bubble'), card: emptySlot('card'), words: emptySlot('words'), history: emptySlot('history'),
    consent: emptySlot('consent'), form: emptySlot('form'),
  };
  private captureExcluded = false;
  /** Counts the shows of each, so a page can tell a new card from an update of the open one without the other's shows
   *  restarting it. */
  private readonly shows = { consent: 0, form: 0 };

  constructor() {
    super();
    ipcMain.on(TEAMMATE_CH.action, this.onAction);
    ipcMain.on(TEAMMATE_CH.size, this.onSize);
    ipcMain.on(TEAMMATE_CH.drag, this.onDrag);
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

  /** `focus`: the user opened it (More), so it takes the keyboard; a card that opens by itself leaves it where it is. */
  showCard(at: Point, s: CardState, opts: { focus?: boolean } = {}): void {
    if (opts.focus) this.slots.card.focusOnShow = true;
    this.showPopup('card', at, s);
  }

  /** Where the bubble or card is now (DIPs), after any drag; null when it isn't shown. */
  placeOf(view: 'bubble' | 'card'): Point | null {
    const slot = this.slots[view];
    return slot.shown && slot.win && !slot.win.isDestroyed() ? { ...slot.at } : null;
  }

  updateCard(s: CardState): void {
    this.update('card', s);
  }

  hideCard(): void {
    this.leave('card', 'fast');
  }

  /**
   * "Paste this into Chrome?" beside the spot `at` (a screen point in DIPs), on the side away from the edge it would
   * leave. It takes clicks but never the keyboard, so the app underneath keeps typing. One decision per card.
   * Returns the card's serial, which its actions carry.
   */
  showConsent(at: Point, s: ConsentState): number {
    const slot = this.slots.consent;
    slot.ended = false;
    this.shows.consent++;
    this.showPopup('consent', at, this.withSide(slot, at, s));
    return this.shows.consent;
  }

  /** The card is decided: clicks during its leave motion no longer count. */
  hideConsent(): void {
    this.slots.consent.ended = true;
    this.leave('consent', 'fast');
  }

  /**
   * "Fill 5 fields in Chrome?" beside the spot `at`, as the consent card: clicks but never the keyboard. One decision
   * per preview, and a fill may name only the rows of the state last sent. Returns the preview's serial.
   */
  showForm(at: Point, s: FormState): number {
    const slot = this.slots.form;
    slot.ended = false;
    slot.formIds = new Set(s.rows.map((r) => r.id));
    this.shows.form++;
    this.showPopup('form', at, this.withSide(slot, at, s));
    return this.shows.form;
  }

  /** The preview is decided: clicks during its leave motion no longer count. */
  hideForm(): void {
    this.slots.form.ended = true;
    this.leave('form', 'fast');
  }

  /**
   * Hides the window now, without the leave motion: a paste is about to click, and the helper refuses a click that
   * would land on a window of lolPing's, even one still fading out. A consent card or preview takes no more clicks.
   */
  hideNow(view: 'bubble' | 'consent' | 'form'): void {
    const slot = this.slots[view];
    if (slot.leaveTimer) clearTimeout(slot.leaveTimer);
    slot.leaveTimer = null;
    slot.ended = true;
    const shown = slot.shown;
    slot.shown = false;
    const w = slot.win;
    if (!w || w.isDestroyed()) return;
    // The page starts its next show from the hidden state, as after a leave.
    if (shown && slot.loaded) w.webContents.send(TEAMMATE_CH.leave, 'fast');
    w.hide();
  }

  /** Whether a screen point in DIPs is over a teammate window on screen: a scroll there is the user reading it. */
  contains(dip: Point): boolean {
    return overShownWindow(dip, VIEWS.map((view) => this.slots[view].win));
  }

  /** Whether the open card, or the one just closed, has had keyboard focus. Cleared when the next card opens. */
  cardHadFocus(): boolean {
    return this.slots.card.hadFocus;
  }

  /**
   * Opens a fresh box at `at`. A box still open from an earlier gesture is cancelled first: its tag, thread and spot
   * belong to that gesture. Each box has its own slot, so a box that is still closing can't end the new one.
   */
  showWords(at: Point, s: WordsState): void {
    const old = this.slots.words;
    old.sendAsk?.(); // the last box's ask goes before this box's spots replace its own
    if (old.win && !old.win.isDestroyed()) this.endWords(old, { t: 'cancel' });
    const slot: Slot = { ...emptySlot('words'), at, state: s, shown: true };
    this.slots.words = slot;
    const w = this.create('words', slot, { focusable: true, ...this.popupOptions() });
    w.setAlwaysOnTop(true, 'screen-saver');
    let focused = false;
    w.on('focus', () => {
      focused = true;
    });
    // Clicking away cancels. Not before the box has had focus once, or showing it would close it.
    w.on('blur', () => {
      if (focused) this.endWords(slot, { t: 'cancel' });
    });
    setTimeout(() => {
      if (!w.isDestroyed() && !focused) this.endWords(slot, { t: 'cancel' });
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
    ipcMain.removeListener(TEAMMATE_CH.drag, this.onDrag);
    for (const view of VIEWS) {
      const slot = this.slots[view];
      if (slot.leaveTimer) clearTimeout(slot.leaveTimer);
      slot.ended = true;
      const w = slot.win;
      this.slots[view] = emptySlot(view);
      if (w && !w.isDestroyed()) w.destroy();
    }
  }

  private showPopup(view: 'bubble' | 'card' | 'consent' | 'form', at: Point, s: MateState): void {
    const slot = this.slots[view];
    if (slot.leaveTimer) clearTimeout(slot.leaveTimer);
    slot.leaveTimer = null;
    slot.state = s;
    slot.shown = true;
    slot.at = at;
    const open = slot.win && !slot.win.isDestroyed() ? slot.win : null;
    // A card window that is still open may hold the focus; a new one starts without it.
    if (!open) slot.hadFocus = false;
    const w = open
      ? open
      // The card can be clicked into for the reply box; the bubble never takes the keyboard.
      : this.create(view, slot, { focusable: view === 'card', ...this.popupOptions() });
    w.setBounds(this.rect(slot));
    if (!slot.loaded) return; // 'did-finish-load' sends the state and shows the window
    this.push(slot);
    this.reveal(w, slot);
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

  private withSide<S extends ConsentState | FormState>(slot: Slot, at: Point, s: S): S {
    return { ...s, side: besideSpot(at, slot.size, this.workArea(at)).side, serial: this.shows[s.view] };
  }

  private update(view: MateView, s: MateState): void {
    const slot = this.slots[view];
    if (!slot.shown) return;
    slot.state = s;
    this.push(slot);
  }

  private leave(view: 'bubble' | 'card' | 'consent' | 'form', how: MateLeave): void {
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
      if (slot.shown || w.isDestroyed()) return;
      // A hidden window the user clicked into keeps the foreground; only closing hands the keyboard back (Windows).
      if (view === 'card' && slot.hadFocus) return this.closeCard(slot, w);
      w.hide();
    }, LEAVE_MS[how]);
  }

  /** Closing is asynchronous: the slot is replaced now, so a card shown meanwhile gets its own window. */
  private closeCard(slot: Slot, w: BrowserWindow): void {
    if (this.slots.card === slot) this.slots.card = { ...emptySlot('card'), hadFocus: true };
    w.close();
  }

  private endWords(slot: Slot, action: MateAction): void {
    if (slot.ended) return;
    slot.ended = true;
    const w = slot.win;
    if (action.t !== 'ask' || !w || w.isDestroyed()) {
      this.emit('action', { view: 'words', action });
      if (w && !w.isDestroyed()) w.close();
      return;
    }
    // The ask reads the window in front and pastes into it: it goes once the box has handed the keyboard back.
    const timer = setTimeout(() => slot.sendAsk?.(), CLOSE_WAIT_MS);
    slot.sendAsk = () => {
      slot.sendAsk = null;
      clearTimeout(timer);
      this.emit('action', { view: 'words', action });
    };
    w.once('closed', () => slot.sendAsk?.());
    w.close();
  }

  private workArea(at: Point): Electron.Rectangle {
    return screen.getDisplayNearestPoint(at).workArea;
  }

  private rect(slot: Slot): { x: number; y: number; width: number; height: number } {
    const area = this.workArea(slot.at);
    const beside = slot.view === 'consent' || slot.view === 'form';
    const { x, y } = beside ? besideSpot(slot.at, slot.size, area) : placeInside(slot.at, slot.size, area);
    return { x, y, ...slot.size };
  }

  private push(slot: Slot): void {
    if (slot.win && !slot.win.isDestroyed() && slot.loaded && slot.state) slot.win.webContents.send(TEAMMATE_CH.state, slot.state);
  }

  private reveal(w: BrowserWindow, slot: Slot): void {
    // Windows can drop an always-on-top window behind normal ones after a while (#70): set the level again each time.
    w.setAlwaysOnTop(true, 'screen-saver');
    if (!slot.focusOnShow) return void w.showInactive();
    slot.focusOnShow = false;
    w.show();
    w.focus();
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
    if (view === 'bubble' || view === 'card' || view === 'consent' || view === 'form') {
      w.setAlwaysOnTop(true, 'screen-saver'); // above the overlay and a game's borderless window
      if (IS_LINUX) w.setVisibleOnAllWorkspaces(true);
      if (IS_MAC) w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
    }
    if (view === 'card') {
      w.on('focus', () => {
        slot.hadFocus = true;
      });
    }
    w.on('closed', () => {
      if (slot.leaveTimer) clearTimeout(slot.leaveTimer);
      if (view === 'words' && !slot.ended) {
        slot.ended = true;
        this.emit('action', { view, action: { t: 'cancel' } });
      }
      if (this.slots[view] === slot) this.slots[view] = emptySlot(view);
    });
    w.webContents.on('did-finish-load', () => {
      slot.loaded = true;
      if (view === 'words' || view === 'history') return this.push(slot); // shown on 'ready-to-show'
      if (!slot.shown) return;
      this.push(slot);
      this.reveal(w, slot);
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
    let action = parseMateAction(raw, view);
    if (!action) return;
    // The words box's job ends with an ask or a cancel: it closes, and the keyboard goes back where it was.
    if (view === 'words') return this.endWords(this.slots.words, action);
    // A click from a card that has since been replaced by the next one is not an answer to the new one.
    if (view === 'consent' || view === 'form') {
      const state = this.slots[view].state;
      const serial = state?.view === view ? state.serial : undefined;
      if (!('serial' in action) || action.serial !== serial) return;
    }
    if (view === 'consent') {
      const slot = this.slots.consent;
      // One decision per card, and no Always allow for a card that didn't offer it.
      if (slot.ended || (action.t === 'always' && !(slot.state?.view === 'consent' && slot.state.always))) return;
      slot.ended = true;
    }
    if (view === 'form') {
      const slot = this.slots.form;
      if (slot.ended) return;
      if (action.t === 'fill') {
        // Only rows the preview listed, each once. A fill naming anything else is not the user's choice: stay open.
        if (!action.ids.every((id) => slot.formIds.has(id))) return;
        action = { ...action, ids: [...new Set(action.ids)] };
      }
      slot.ended = true;
    }
    this.emit('action', { view, action });
  };

  /** The user drags the bubble or card: it stays where it is dropped when its page resizes, and the card opens there. */
  private readonly onDrag = (event: IpcMainEvent, raw: unknown): void => {
    const view = this.viewOf(event);
    const d = view ? parseMateDrag(raw, view) : null;
    if (!view || !d || (view !== 'bubble' && view !== 'card')) return;
    const slot = this.slots[view];
    const w = slot.win;
    if (!w || w.isDestroyed()) return;
    if (d.phase === 'start') {
      const { x, y } = w.getBounds();
      slot.dragFrom = { x, y };
      return;
    }
    const from = slot.dragFrom;
    if (!from) return;
    slot.at = { x: from.x + d.dx, y: from.y + d.dy };
    w.setPosition(slot.at.x, slot.at.y);
    if (d.phase !== 'end') return;
    slot.dragFrom = null;
    this.emit('dragged', view);
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

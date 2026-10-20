import { featureOn } from './features';
import type { Settings } from './settings';

/** Which wheel a gesture belongs to: the ping trigger's, the emote key's or the teammate's ask key. */
export type WheelKind = 'ping' | 'emote' | 'ask';

/** The helper's `ready` version this build expects. 5: the ask key, `"wheel":"ask"` and `triggerUp`. */
export const HELPER_VERSION = 5;

/**
 * Messages the hook helper writes to stdout, one JSON object per line.
 * Coordinates are physical pixels on Windows/Linux and global points (Electron DIPs) on macOS.
 */
export type HelperEvent =
  | { type: 'ready'; version: number }
  | { type: 'wheelOpen' | 'wheelMove' | 'wheelRelease' | 'click'; x: number; y: number; wheel: WheelKind }
  | { type: 'cancel' }
  | { type: 'toggled'; enabled: boolean }
  | { type: 'textRequested' }
  | { type: 'panel'; show: boolean }
  /** A wheel's trigger key came up after a release or click while it was held. */
  | { type: 'triggerUp'; wheel: WheelKind }
  | { type: 'error'; message: string; code?: string }
  | { type: 'sim'; swallow: boolean; inject: string };

/** `noAccess`: macOS Accessibility access or a supported Linux X11 session is missing. */
export type HelperStatus = 'starting' | 'running' | 'failed' | 'noAccess';

/** The helper's exit code when OS input is unavailable (macOS permissions / unsupported Linux session). */
export const HELPER_EXIT_NO_ACCESS = 3;

type PointType = 'wheelOpen' | 'wheelMove' | 'wheelRelease' | 'click';
const POINT_TYPES = new Set<string>(['wheelOpen', 'wheelMove', 'wheelRelease', 'click']);
const isInt = (x: unknown): x is number => Number.isInteger(x);
const isWheel = (x: unknown): x is WheelKind => x === 'ping' || x === 'emote' || x === 'ask';

export function parseHelperLine(line: string): HelperEvent | null {
  let v: unknown;
  try {
    v = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  switch (o.type) {
    case 'ready':
      return isInt(o.version) ? { type: 'ready', version: o.version } : null;
    case 'cancel':
      return { type: 'cancel' };
    case 'toggled':
      return typeof o.enabled === 'boolean' ? { type: 'toggled', enabled: o.enabled } : null;
    case 'textRequested':
      return { type: 'textRequested' };
    case 'panel':
      return typeof o.show === 'boolean' ? { type: 'panel', show: o.show } : null;
    case 'triggerUp':
      return isWheel(o.wheel) ? { type: 'triggerUp', wheel: o.wheel } : null;
    case 'error':
      if (typeof o.message !== 'string') return null;
      return typeof o.code === 'string' ? { type: 'error', message: o.message, code: o.code } : { type: 'error', message: o.message };
    case 'sim':
      return typeof o.swallow === 'boolean' && typeof o.inject === 'string'
        ? { type: 'sim', swallow: o.swallow, inject: o.inject }
        : null;
    default:
      if (typeof o.type === 'string' && POINT_TYPES.has(o.type) && isInt(o.x) && isInt(o.y)) {
        // Anything unknown (including no field, from a version 1 helper) is the ping wheel.
        return { type: o.type as PointType, x: o.x, y: o.y, wheel: isWheel(o.wheel) ? o.wheel : 'ping' };
      }
      return null;
  }
}

export type HelperTrigger = 'alt' | 'ctrl' | 'shift' | 'win' | 'capslock' | 'mouse4' | 'mouse5' | 'vk';

/** Messages Electron writes to the helper's stdin. Flat objects only: the C++ parser has no nesting. */
export type HelperCommand =
  | {
      type: 'config';
      trigger: HelperTrigger;
      triggerVk: number;
      clickPing: boolean;
      /** Fullscreen apps keep every click: no wheel gestures while one is in front. */
      gameCheck: boolean;
      /** 'off': no emote key, so no emote gestures. */
      emoteTrigger: HelperTrigger | 'off';
      emoteTriggerVk: number;
      emoteClick: boolean;
      /** 'off': no separate ask key (the teammate is off, or it shares the ping key). */
      askTrigger: HelperTrigger | 'off';
      askTriggerVk: number;
      askClick: boolean;
      dragThresholdPx: number;
      toggleMods: number;
      toggleVk: number;
      textMods: number;
      textVk: number;
      panelVk: number;
      enabled: boolean;
    }
  | { type: 'setEnabled'; enabled: boolean }
  | { type: 'suspend'; on: boolean }
  | { type: 'shutdown' };

/**
 * `live.text` and `live.panel` are false outside a room: a key code of 0 tells the helper to leave that key
 * (the text shortcut, the panel key) to other apps.
 */
export function configCommand(
  s: Settings,
  enabled: boolean,
  live: { text: boolean; panel: boolean } = { text: false, panel: false },
): HelperCommand {
  const t = s.trigger;
  // With the Emotes feature off the helper gets no emote key, so no emote wheel or emote click.
  const e = featureOn(s, 'emotes') ? s.emoteTrigger : 'off';
  // 'same' asks on the ping wheel, so the helper gets no ask key and reports ping gestures as usual.
  const a = featureOn(s, 'teammate') && s.teammate.askTrigger !== 'same' ? s.teammate.askTrigger : 'off';
  // ...and a ping-key click opens the words box, so the helper reports clicks even with click to ping off.
  const sameWords = featureOn(s, 'teammate') && s.teammate.askTrigger === 'same' && s.teammate.askClick;
  return {
    type: 'config',
    trigger: typeof t === 'object' ? 'vk' : t,
    triggerVk: typeof t === 'object' ? t.vk : 0,
    clickPing: s.clickPing || sameWords,
    gameCheck: s.gameCheck,
    emoteTrigger: typeof e === 'object' ? 'vk' : e,
    emoteTriggerVk: typeof e === 'object' ? e.vk : 0,
    emoteClick: s.emoteClick && e !== 'off',
    askTrigger: typeof a === 'object' ? 'vk' : a,
    askTriggerVk: typeof a === 'object' ? a.vk : 0,
    askClick: s.teammate.askClick && a !== 'off',
    dragThresholdPx: s.dragThresholdPx,
    toggleMods: s.toggleHotkey.mods,
    toggleVk: s.toggleHotkey.vk,
    textMods: s.textHotkey.mods,
    textVk: live.text ? s.textHotkey.vk : 0,
    panelVk: live.panel ? s.panelKey : 0,
    enabled,
  };
}

export const serializeCommand = (c: HelperCommand): string => `${JSON.stringify(c)}\n`;

import type { Platform } from '../platform';
import { isPingId, type PingId } from '../pings';
import { isTagColor, isTagRgb, readableTagRgb, type TagRgb } from '../roomColors';
import { sanitizeName } from '../roomProtocol';
import type { EmoteTriggerKey, NamedTrigger, TriggerKey } from '../settings';
import { parsePermissionKey } from './doRules';
import { PROVIDER_IDS, type ProviderId } from './providers';

/** The ask key: a trigger key of its own, or the ping key ('same'). */
export type AskTrigger = TriggerKey | 'same';

/** Every ping the teammate can answer with is an intent, so intents are keyed by ping id. */
export type IntentId = PingId;

export interface IntentOverride {
  enabled?: boolean;
  label?: string;
  instruction?: string;
}

export interface BuiltinProfile {
  id: string;
  kind: 'builtin';
  name: string;
  tagColor: number;
  tagColorCustom: TagRgb | null;
  provider: ProviderId;
  protocol: 'openai' | 'anthropic';
  baseUrl: string;
  model: string;
}

/** Built-in profiles only for now; agent profiles join this union later. */
export type Profile = BuiltinProfile;

export interface TeammateSettings {
  askTrigger: AskTrigger;
  /** Ask key + click (no drag) opens the words box. */
  askClick: boolean;
  askDoubleTap: boolean;
  tagName: string;
  tagColor: number;
  tagColorCustom: TagRgb | null;
  /** Overrides only: an intent not listed here uses its built-in default. */
  intents: Partial<Record<IntentId, IntentOverride>>;
  profiles: Profile[];
  defaultProfile: string | null;
  deepProfile: string | null;
  context: { marks: boolean; systemText: boolean; files: boolean; webPdfs: boolean; clipboardForForms: boolean };
  emotes: boolean;
  receiptSound: boolean;
  /** keepDays null keeps threads until the thread cap removes them. */
  history: { on: boolean; keepDays: number | null; maxThreads: number; paused: boolean };
  permissions: string[];
  firstRunDone: boolean;
}

/** The separate ask key a clash falls back to. */
const FALLBACK_ASK: TriggerKey = 'win';

/** `askClick` is per platform (off on macOS); normalizeTeammate sets it, this value is the Windows and Linux one. */
export const DEFAULT_TEAMMATE: TeammateSettings = {
  askTrigger: FALLBACK_ASK,
  askClick: true,
  askDoubleTap: false,
  tagName: 'AI',
  tagColor: 3,
  tagColorCustom: null,
  intents: {},
  profiles: [],
  defaultProfile: null,
  deepProfile: null,
  context: { marks: true, systemText: true, files: true, webPdfs: false, clipboardForForms: false },
  emotes: true,
  receiptSound: true,
  history: { on: true, keepDays: 30, maxThreads: 500, paused: false },
  permissions: [],
  firstRunDone: false,
};

export const MAX_PROFILES = 20;
export const INTENT_LABEL_MAX = 40;
export const INTENT_INSTRUCTION_MAX = 2000;
export const TAG_NAME_MAX = 12;
const FIELD_MAX = 2048;
const MAX_PERMISSIONS = 200;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const bool = (v: unknown, fallback: boolean): boolean => (typeof v === 'boolean' ? v : fallback);
const oneOf = <T extends string>(v: unknown, list: readonly T[]): v is T => typeof v === 'string' && (list as readonly string[]).includes(v);
const cut = (s: string, max: number): string => [...s].slice(0, max).join('');

// The same key rules as settings.ts, which imports this file for its defaults and so can't be imported back here.
const NAMED: readonly NamedTrigger[] = ['alt', 'ctrl', 'shift', 'win', 'capslock', 'mouse4', 'mouse5'];
const CAPS_LOCK_VK = 0x14;
const isVk = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 254;

function askKey(raw: unknown, platform: Platform): TriggerKey | null {
  if (platform !== 'win' && (raw === 'capslock' || (isObj(raw) && raw.vk === CAPS_LOCK_VK))) return null;
  if (oneOf(raw, NAMED)) return raw;
  if (isObj(raw) && isVk(raw.vk)) return { vk: raw.vk };
  return null;
}

const vkOf = (t: EmoteTriggerKey): number | null => (typeof t === 'object' ? t.vk : t === 'capslock' ? CAPS_LOCK_VK : null);

function sameKey(a: EmoteTriggerKey, b: EmoteTriggerKey): boolean {
  const x = vkOf(a);
  const y = vkOf(b);
  return x !== null && y !== null ? x === y : a === b;
}

/**
 * A separate ask key never shares the ping key or the emote key. One that does moves to Win: only an explicit 'same'
 * shares the ping key, since that stops the user's pings reaching the room. 'same' is the last resort when Win is taken.
 */
function askTrigger(raw: unknown, ctx: { platform: Platform; trigger: TriggerKey; emoteTrigger: EmoteTriggerKey }): AskTrigger {
  if (raw === 'same') return 'same';
  const taken = (k: TriggerKey): boolean => sameKey(k, ctx.trigger) || sameKey(k, ctx.emoteTrigger);
  const key = askKey(raw, ctx.platform) ?? FALLBACK_ASK;
  if (!taken(key)) return key;
  return taken(FALLBACK_ASK) ? 'same' : FALLBACK_ASK;
}

function intents(raw: unknown): Partial<Record<IntentId, IntentOverride>> {
  const out: Partial<Record<IntentId, IntentOverride>> = {};
  if (!isObj(raw)) return out;
  for (const [id, v] of Object.entries(raw)) {
    if (!isPingId(id) || !isObj(v)) continue;
    const o: IntentOverride = {};
    if (typeof v.enabled === 'boolean') o.enabled = v.enabled;
    if (typeof v.label === 'string') o.label = cut(v.label.trim(), INTENT_LABEL_MAX);
    if (typeof v.instruction === 'string') o.instruction = cut(v.instruction, INTENT_INSTRUCTION_MAX);
    if (Object.keys(o).length > 0) out[id] = o;
  }
  return out;
}

function profile(raw: unknown): Profile | null {
  if (!isObj(raw) || raw.kind !== 'builtin') return null;
  const { id, name, provider, protocol, baseUrl, model } = raw;
  if (typeof id !== 'string' || id === '' || id.length > 64 || typeof name !== 'string' || typeof baseUrl !== 'string'
    || typeof model !== 'string' || !oneOf(provider, PROVIDER_IDS) || !oneOf(protocol, ['openai', 'anthropic'] as const)) return null;
  return {
    id, kind: 'builtin', name: cut(name.trim(), 60), provider, protocol, baseUrl: cut(baseUrl, FIELD_MAX), model: cut(model, 200),
    tagColor: isTagColor(raw.tagColor) ? raw.tagColor : DEFAULT_TEAMMATE.tagColor,
    tagColorCustom: isTagRgb(raw.tagColorCustom) ? readableTagRgb(raw.tagColorCustom) : null,
  };
}

function profiles(raw: unknown): Profile[] {
  if (!Array.isArray(raw)) return [];
  const out: Profile[] = [];
  for (const item of raw) {
    const p = profile(item);
    if (p && !out.some((o) => o.id === p.id)) out.push(p);
    if (out.length >= MAX_PROFILES) break;
  }
  return out;
}

const positiveInt = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 1;

function history(raw: unknown): TeammateSettings['history'] {
  const d = DEFAULT_TEAMMATE.history;
  const h = isObj(raw) ? raw : {};
  return {
    on: bool(h.on, d.on),
    keepDays: h.keepDays === null ? null : positiveInt(h.keepDays) ? h.keepDays : d.keepDays,
    maxThreads: positiveInt(h.maxThreads) ? h.maxThreads : d.maxThreads,
    paused: bool(h.paused, d.paused),
  };
}

function context(raw: unknown): TeammateSettings['context'] {
  const d = DEFAULT_TEAMMATE.context;
  const c = isObj(raw) ? raw : {};
  return {
    marks: bool(c.marks, d.marks), systemText: bool(c.systemText, d.systemText), files: bool(c.files, d.files),
    webPdfs: bool(c.webPdfs, d.webPdfs), clipboardForForms: bool(c.clipboardForForms, d.clipboardForForms),
  };
}

/** Turns anything into valid TeammateSettings: the ask key is judged against the ping and emote keys of the same file. */
export function normalizeTeammate(
  raw: unknown,
  ctx: { platform: Platform; trigger: TriggerKey; emoteTrigger: EmoteTriggerKey },
): TeammateSettings {
  const r = isObj(raw) ? raw : {};
  const list = profiles(r.profiles);
  const known = (id: unknown): string | null => (typeof id === 'string' && list.some((p) => p.id === id) ? id : null);
  const tagName = typeof r.tagName === 'string'
    ? sanitizeName(r.tagName.slice(0, 256), DEFAULT_TEAMMATE.tagName, TAG_NAME_MAX)
    : DEFAULT_TEAMMATE.tagName;
  const permissions = Array.isArray(r.permissions)
    ? r.permissions.filter((p): p is string => {
      if (typeof p !== 'string' || p.length > 200) return false;
      const k = parsePermissionKey(p);
      return k !== null && known(k.profileId) !== null;
    })
    : [];
  return {
    askTrigger: askTrigger(r.askTrigger, ctx),
    askClick: bool(r.askClick, ctx.platform !== 'mac'),
    askDoubleTap: bool(r.askDoubleTap, DEFAULT_TEAMMATE.askDoubleTap),
    tagName,
    tagColor: isTagColor(r.tagColor) ? r.tagColor : DEFAULT_TEAMMATE.tagColor,
    tagColorCustom: isTagRgb(r.tagColorCustom) ? readableTagRgb(r.tagColorCustom) : null,
    intents: intents(r.intents),
    profiles: list,
    defaultProfile: known(r.defaultProfile),
    deepProfile: known(r.deepProfile),
    context: context(r.context),
    emotes: bool(r.emotes, DEFAULT_TEAMMATE.emotes),
    receiptSound: bool(r.receiptSound, DEFAULT_TEAMMATE.receiptSound),
    history: history(r.history),
    permissions: [...new Set(permissions)].slice(0, MAX_PERMISSIONS),
    firstRunDone: bool(r.firstRunDone, DEFAULT_TEAMMATE.firstRunDone),
  };
}

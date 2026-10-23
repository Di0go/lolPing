import type { Rect } from './coords';

export const PUT_ACTIONS = ['paste', 'fill', 'event', 'open'] as const;
export type PutAction = (typeof PUT_ACTIONS)[number];

export const permissionKey = (profileId: string, action: PutAction): string => `${profileId}:${action}`;

/** The profile and action behind a saved key, or null when the key isn't one permissionKey could have made. */
export function parsePermissionKey(key: string): { profileId: string; action: PutAction } | null {
  const at = key.lastIndexOf(':');
  const action = key.slice(at + 1);
  const known = PUT_ACTIONS.find((a) => a === action);
  return at > 0 && known ? { profileId: key.slice(0, at), action: known } : null;
}

/** Whether the user chose Always allow for this action. Fill never is: it always shows its preview. */
export function allowed(permissions: readonly string[], profileId: string, action: PutAction): boolean {
  if (action === 'fill') return false;
  return permissions.includes(permissionKey(profileId, action));
}

// English patterns match whole words, plural too, so "PIN" does not catch "Shipping"; a `_` in the label counts as a
// word break ("password_confirm"). Chinese has no word breaks: substrings. 账号 alone is also a login name, so only
// 银行账号 and 银行账户 (bank account) are listed.
const NEVER_FILL_LABELS: readonly RegExp[] = [
  /\bpass(?:word|wd|code|phrase)s?\b/i,
  /\bpins?\b/i,
  /\b(?:credit|debit)\s+cards?\b/i,
  /\bcard\s*(?:number|num|no|#)(?!\w)/i,
  /\bcv[vcn]2?s?\b/i,
  /\bsecurity\s+codes?\b/i,
  /\bexpir(?:y|ation|es)s?\b/i,
  /\bibans?\b/i,
  /\b(?:account|routing)\s*(?:number|num|no)s?\b/i,
  /\bssns?\b/i,
  /\bsocial\s+security\b/i,
  /\bpassports?\b/i,
  /\b(?:id|identity|identification)\s*(?:number|num|no)s?\b/i,
  /\bexp\.?\s*dates?\b/i,
  /\bmm\s*\/\s*yy/i,
  /\bvalid\s+(?:thru|through|until)\b/i,
  /\b(?:national|tax)\s+ids?\b/i,
  /\bid\s+cards?\b/i,
  /\btins?\b/i,
  /\bcc\s*(?:number|num|no)s?\b/i,
  /\bcard\s+verification\b/i,
  /\bone[-\s]time\s+codes?\b/i,
  /\bverification\s+codes?\b/i,
  /\botps?\b/i,
  /\bpwds?\b/i,
  /\bsort\s+codes?\b/i,
  /\ba\/c\s*(?:number|num|no)s?\b/i,
  /\bsocial\s+insurance\b/i,
  /密码|卡号|银行卡|安全码|有效期|身份证|护照|证件号|信用卡|借记卡|银行账号|银行账户|验证码|纳税人识别号|社保/,
];

// HTML autocomplete tokens for secrets; a field can carry several tokens ("billing cc-number").
const NEVER_FILL_AUTOCOMPLETE =
  /^(?:cc-number|cc-csc|cc-exp(?:-month|-year)?|current-password|new-password|one-time-code)$/;

/** True for a field that is never filled: secure, an autocomplete token for a secret, or an EN or ZH label for a
 *  password, PIN, card number, security code, expiry, bank account, SSN, passport, ID or tax number, or one-time
 *  code. */
export function neverFill(field: { label: string; secure: boolean; autocomplete?: string }): boolean {
  if (field.secure) return true;
  if (field.autocomplete?.toLowerCase().split(/\s+/).some((t) => NEVER_FILL_AUTOCOMPLETE.test(t))) return true;
  const label = field.label.replace(/_/g, ' ');
  return NEVER_FILL_LABELS.some((p) => p.test(label));
}

/** The longest FormField id, as the helper's kFieldIdMax: one that is longer is no id of a field, not one to cut. */
export const FIELD_ID_MAX = 120;

export interface FormField {
  id: string;
  kind: 'text' | 'multiline' | 'combo' | 'checkbox' | 'radio' | 'other';
  label: string;
  group: string;
  value: string;
  secure: boolean;
  required: boolean;
  options: string[];
  /** On screen in physical px, when the helper gave one. */
  box?: Rect;
}
export interface PreviewRow { id: string; label: string; value: string; checked: boolean }
export interface LeftField { label: string; reason: 'secure' | 'unknown' | 'kind' | 'option' }

/** The model's fill matched to the listed fields: rows to fill (checked by default), and fields left for the user
 *  (never-fill, unknown ids, kinds it can't write, values not among a combo's options), each with the reason. */
export function formPreview(
  fields: FormField[],
  fill: { id: string; value: string }[],
): { rows: PreviewRow[]; left: LeftField[] } {
  const byId = new Map(fields.map((f) => [f.id, f]));
  const rows: PreviewRow[] = [];
  const left: LeftField[] = [];
  for (const { id, value } of fill) {
    const f = byId.get(id);
    if (!f) {
      left.push({ label: id, reason: 'unknown' });
    } else if (neverFill(f)) {
      left.push({ label: f.label, reason: 'secure' });
    } else if (f.kind === 'other') {
      left.push({ label: f.label, reason: 'kind' });
    } else if (f.kind === 'checkbox' && value !== 'on' && value !== 'off') {
      left.push({ label: f.label, reason: 'kind' });
    } else if (f.kind === 'combo' && !comboAccepts(f.options, value)) {
      left.push({ label: f.label, reason: 'option' });
    } else {
      // Any value chooses a radio (tools.ts), and the writer chooses it with `on`.
      rows.push({ id, label: f.label, value: f.kind === 'radio' ? 'on' : value, checked: true });
    }
  }
  return { rows, left };
}

/** A combo that lists no options is free text. */
function comboAccepts(options: string[], value: string): boolean {
  const listed = options.filter((o) => o !== '');
  return listed.length === 0 || listed.includes(value);
}

export type PasteMethod = 'clipboard' | 'copy';

/** Spec §10.3 with §16 (2026-10-21): no paste into a secure field, a changed foreground window, or a replace whose
 *  selection no longer holds the asked text; those copy instead and name why. */
export function pastePlan(p: {
  mode: 'insert' | 'replace';
  secure: boolean;
  sameWindow: boolean;
  selectionNow: string | null;
  selectionAsked: string | null;
}): { method: PasteMethod; why?: 'secure' | 'window' | 'selection' } {
  if (p.secure) return { method: 'copy', why: 'secure' };
  if (!p.sameWindow) return { method: 'copy', why: 'window' };
  if (p.mode === 'replace') {
    const asked = p.selectionAsked?.trim() ?? '';
    // Replacing a selection the user has since changed would overwrite text they never offered.
    if (asked === '' || p.selectionNow?.trim() !== asked) return { method: 'copy', why: 'selection' };
  }
  return { method: 'clipboard' };
}

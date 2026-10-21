export type PutAction = 'paste' | 'fill' | 'event' | 'open';

export const permissionKey = (profileId: string, action: PutAction): string => `${profileId}:${action}`;

/** Whether the user chose Always allow for this action. Fill never is: it always shows its preview. */
export function allowed(permissions: readonly string[], profileId: string, action: PutAction): boolean {
  if (action === 'fill') return false;
  return permissions.includes(permissionKey(profileId, action));
}

// English patterns match whole words, so "PIN" does not catch "Shipping". Chinese has no word breaks: substrings.
const NEVER_FILL_LABELS: readonly RegExp[] = [
  /\bpass(?:word|wd|code|phrase)\b/i,
  /\bpin\b/i,
  /\b(?:credit|debit)\s+card\b/i,
  /\bcard\s*(?:number|num|no|#)(?!\w)/i,
  /\bcv[vcn]2?\b/i,
  /\bsecurity\s+code\b/i,
  /\bexpir(?:y|ation|es)\b/i,
  /\biban\b/i,
  /\b(?:account|routing)\s*(?:number|num|no)\b/i,
  /\bssn\b/i,
  /\bsocial\s+security\b/i,
  /\bpassport\b/i,
  /\b(?:id|identity|identification)\s*(?:number|num|no)\b/i,
  /密码|卡号|银行卡|安全码|有效期|身份证|护照|证件号/,
];

// HTML autocomplete tokens for secrets; a field can carry several tokens ("billing cc-number").
const NEVER_FILL_AUTOCOMPLETE =
  /^(?:cc-number|cc-csc|cc-exp(?:-month|-year)?|current-password|new-password|one-time-code)$/;

/** True for a field that is never filled: secure, an autocomplete token for a secret, or an EN or ZH label for a
 *  password, PIN, card number, security code, expiry, bank account, SSN, passport or ID number. */
export function neverFill(field: { label: string; secure: boolean; autocomplete?: string }): boolean {
  if (field.secure) return true;
  if (field.autocomplete?.toLowerCase().split(/\s+/).some((t) => NEVER_FILL_AUTOCOMPLETE.test(t))) return true;
  return NEVER_FILL_LABELS.some((p) => p.test(field.label));
}

export interface FormField {
  id: string;
  kind: 'text' | 'multiline' | 'combo' | 'checkbox' | 'radio' | 'other';
  label: string;
  group: string;
  value: string;
  secure: boolean;
  required: boolean;
  options: string[];
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
      rows.push({ id, label: f.label, value, checked: true });
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

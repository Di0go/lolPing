import type { Rect } from './coords';

export const PUT_ACTIONS = ['paste', 'fill', 'event', 'open'] as const;
export type PutAction = (typeof PUT_ACTIONS)[number];

export const permissionKey = (profileId: string, action: PutAction): string => `${profileId}:${action}`;

export type AgentAction = `agent:${string}`;

export const agentPermissionKey = (profileId: string, tool: string): string => `${profileId}:agent:${tool}`;

const AGENT_MARK = ':agent:';

/** The profile and action (or agent tool) behind a saved key, or null when the key isn't one a key maker could make. */
export function parsePermissionKey(
  key: string,
): { profileId: string; action: PutAction } | { profileId: string; action: 'agent'; tool: string } | null {
  const mark = key.lastIndexOf(AGENT_MARK);
  if (mark > 0 && key.length > mark + AGENT_MARK.length) {
    return { profileId: key.slice(0, mark), action: 'agent', tool: key.slice(mark + AGENT_MARK.length) };
  }
  const at = key.lastIndexOf(':');
  const action = key.slice(at + 1);
  const known = PUT_ACTIONS.find((a) => a === action);
  return at > 0 && known ? { profileId: key.slice(0, at), action: known } : null;
}

/** A tool that runs commands never gets Always allow: Bash, PowerShell, or any name with "shell" or "exec". */
export function isShellTool(tool: string): boolean {
  return /^(?:bash|powershell)$/i.test(tool) || /shell|exec/i.test(tool);
}

/** Whether the user chose Always allow for this agent tool. A shell tool never is. */
export function agentAllowed(permissions: readonly string[], profileId: string, tool: string): boolean {
  return !isShellTool(tool) && permissions.includes(agentPermissionKey(profileId, tool));
}

/** What the card says an agent's tool call is, and the file or address it names (for `edit` and `open`). */
export function agentWhat(tool: string, input: unknown): { kind: 'edit' | 'run' | 'open' | 'use'; target: string } {
  const field = (name: string): string => {
    const v = isRecord(input) ? input[name] : undefined;
    return typeof v === 'string' ? v : '';
  };
  if (/^(?:bash|powershell)$/i.test(tool)) return { kind: 'run', target: '' };
  if (EDIT_TOOLS.test(tool)) {
    const file = field('file_path') || field('notebook_path');
    if (file !== '') return { kind: 'edit', target: file };
  } else if (/^webfetch$/i.test(tool) && field('url') !== '') {
    return { kind: 'open', target: field('url') };
  }
  return { kind: 'use', target: '' };
}

const EDIT_TOOLS = /^(?:edit|write|multiedit|notebookedit)$/i;

/** Claude Code's tools that write a file: Edit, Write, MultiEdit, NotebookEdit. */
export const isEditTool = (tool: string): boolean => EDIT_TOOLS.test(tool);
/** The consent card's detail for an agent's tool call is cut here. */
const AGENT_DETAIL_MAX = 400;
/** An edit's detail shows a path longer than head + tail characters as its start and end. */
const AGENT_PATH_HEAD = 80;
const AGENT_PATH_TAIL = 110;
/** A command's detail shows this many lines. */
const AGENT_COMMAND_LINES = 8;
/** An edit's detail shows this many lines of the new text. */
const AGENT_EDIT_LINES = 3;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Cuts at `max` characters and says so: a card must not look whole when it is not. */
const cutTo = (text: string, max: number): string => {
  const chars = Array.from(text);
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join('')}…`;
};

// Controls other than a line break or tab, Unicode line and paragraph separators (drawn as line breaks, but a shell
// reads them as letters), every format character and every other invisible one (zero-width, direction marks, variation
// selectors, fillers, the Braille blank): shown escaped, so the card can't draw something other than what will run.
const UNSAFE_CLASS = '[\\p{Zl}\\p{Zp}\\p{Cf}\\p{Default_Ignorable_Code_Point}\\u2800]';
const UNSAFE_LAYOUT = new RegExp(`(?![\\n\\t])\\p{Cc}|${UNSAFE_CLASS}`, 'gu');
const UNSAFE_ALL = new RegExp(`\\p{Cc}|${UNSAFE_CLASS}`, 'gu');

/**
 * `text` with unsafe characters as \uXXXX; a line break and tab stay unless `oneLine`. CR LF is folded into a line
 * break only for `foldCrlf`: bash keeps a CR inside the word it ends, so a CR must show wherever it would run.
 */
function escapeUnsafe(text: string, o: { oneLine?: boolean; foldCrlf?: boolean } = {}): string {
  const folded = o.foldCrlf ? text.replace(/\r\n/g, '\n') : text;
  return folded.replace(o.oneLine ? UNSAFE_ALL : UNSAFE_LAYOUT, (c) => {
    const hex = (c.codePointAt(0) ?? 0).toString(16).toUpperCase();
    return hex.length > 4 ? `\\u{${hex}}` : `\\u${hex.padStart(4, '0')}`;
  });
}

/** A command with its padding squeezed out, so blank lines or spaces can't push the rest of it out of view. */
const squeeze = (text: string): string => text
  .replace(/[\t\p{Zs}]{4,}/gu, ' ')
  .replace(/(?:[\t\p{Zs}]*\n){3,}/gu, '\n\n');

/** However the padding is made, a command shows this many lines, then "…", and counts the lines it left out. */
function capLines(text: string): { text: string; left: number } {
  const lines = text.split('\n');
  if (lines.length <= AGENT_COMMAND_LINES) return { text, left: 0 };
  return { text: [...lines.slice(0, AGENT_COMMAND_LINES), '…'].join('\n'), left: lines.length - AGENT_COMMAND_LINES };
}

/**
 * A file or address in the card's question and the history line: escaped, and when it is longer than `max` the end is
 * kept (the file name) with a "…" in front.
 */
export function agentLabel(text: string, max: number): string {
  const chars = Array.from(escapeUnsafe(text, { oneLine: true }));
  return chars.length <= max ? chars.join('') : `…${chars.slice(chars.length - (max - 1)).join('')}`;
}

/** A path longer than the head and tail together shows both ends: "C:\Users\…\notes.txt". */
function agentPath(path: string): string {
  const chars = Array.from(escapeUnsafe(path, { oneLine: true }));
  if (chars.length <= AGENT_PATH_HEAD + AGENT_PATH_TAIL) return chars.join('');
  return `${chars.slice(0, AGENT_PATH_HEAD).join('')}…${chars.slice(chars.length - AGENT_PATH_TAIL).join('')}`;
}

/**
 * The start of the text an edit puts in. Each tool keeps it under its own name, and only that one is read, so a stray
 * extra key can't change what the card shows. What is left out is marked with "…" after the first lines and counted,
 * with the edits a MultiEdit has besides its first.
 */
function newText(tool: string, input: Record<string, unknown>): { text: string; lines: number; edits: number } {
  const edits = Array.isArray(input.edits) && /^multiedit$/i.test(tool) ? input.edits : [];
  const first = isRecord(edits[0]) ? edits[0].new_string : undefined;
  const field: Record<string, unknown> = {
    write: input.content, edit: input.new_string, multiedit: first, notebookedit: input.new_source,
  };
  const text = field[tool.toLowerCase()];
  const lines = typeof text === 'string' ? text.replace(/\r\n/g, '\n').split('\n') : [];
  const shown = lines.slice(0, AGENT_EDIT_LINES);
  if (lines.length > AGENT_EDIT_LINES) shown.push('…');
  return {
    text: shown.join('\n'), lines: Math.max(0, lines.length - AGENT_EDIT_LINES), edits: Math.max(0, edits.length - 1),
  };
}

/** The card's detail and what it left out: lines of a command or of the new text, and a MultiEdit's other edits. */
export interface AgentDetail { text: string; moreLines: number; moreEdits: number }

/**
 * What the consent card shows for an agent's tool call: a command, a file and the first lines of an edit, an address,
 * or the input as compact JSON. At most 400 characters, and whatever is left out is marked with "…" and the lines and
 * edits left out counted, for the card to say below its detail box. A path shows its start and end, and control,
 * line-separator and invisible characters are escaped.
 */
export function describeAgentInput(tool: string, input: unknown): AgentDetail {
  const { kind, target } = agentWhat(tool, input);
  if (!isRecord(input)) return { text: '', moreLines: 0, moreEdits: 0 };
  let text = '';
  let moreLines = 0;
  let moreEdits = 0;
  if (kind === 'run' && typeof input.command === 'string') {
    const capped = capLines(squeeze(escapeUnsafe(input.command, { foldCrlf: /^powershell$/i.test(tool) })));
    text = capped.text;
    moreLines = capped.left;
  } else if (kind === 'edit') {
    const body = newText(tool, input);
    text = [agentPath(target), escapeUnsafe(body.text, { foldCrlf: true })].filter((s) => s !== '').join('\n');
    moreLines = body.lines;
    moreEdits = body.edits;
  } else if (kind === 'open') {
    text = escapeUnsafe(target, { oneLine: true });
  } else {
    text = escapeUnsafe(JSON.stringify(input));
  }
  return { text: cutTo(text, AGENT_DETAIL_MAX), moreLines, moreEdits };
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
  /\bmm\s*\/\s*yy\b/i,
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

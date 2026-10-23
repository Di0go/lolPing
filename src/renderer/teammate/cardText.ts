import type { Strings } from '../../shared/i18n';
import { MATE_COPY_MAX, type CardState, type ConsentState, type PutState } from '../../shared/teammateIpc';

/**
 * What Copy takes: the latest answer without its line, so a reply, rewrite or grab pastes as it is; the line when
 * that is all there is. Cut to what the main process accepts, so a Copy is never refused.
 */
export function copyText(entries: CardState['entries']): string {
  const last = entries.filter((e) => e.kind === 'answer').at(-1);
  return (last ? last.markdown || last.line || '' : '').slice(0, MATE_COPY_MAX);
}

/** "profile · model · tokens · Used: a, b", with the language's own separators. */
export function footerText(footer: CardState['footer'], ui: Strings['teammate']['ui']): string {
  return [
    footer.profile,
    footer.model,
    footer.tokens !== null ? ui.tokens(footer.tokens) : '',
    footer.used.length ? `${ui.used}${ui.labelSep}${footer.used.join(ui.listSep)}` : '',
  ].filter(Boolean).join(ui.sep);
}

/** The put button's words for the action it carries out; null when there is no button. */
export function putLabel(put: PutState, ui: Strings['teammate']['ui']): string | null {
  switch (put) {
    case 'paste': return ui.putPaste;
    case 'replace': return ui.putReplace;
    case 'fill': return ui.putFill;
    case 'ready': return ui.putReady;
    default: return null;
  }
}

/** The bubble's buttons in order. The put button comes last, so its arrival never moves one the pointer may be on. */
export function bubbleButtons(more: boolean, put: string | null): ('more' | 'put')[] {
  return [...(more ? ['more' as const] : []), ...(put ? ['put' as const] : [])];
}

/** The card's buttons in order, the put button last for the same reason. */
export function cardButtons(put: string | null): ('copy' | 'deep' | 'history' | 'put')[] {
  return ['copy', 'deep', 'history', ...(put ? ['put' as const] : [])];
}

/** A put button this new may have appeared under a click meant for something else: that click is not consent. */
export const PUT_ARM_MS = 400;

/** Counts a put click only once its button, with its current label, has been on screen PUT_ARM_MS. */
export class PutGuard {
  private label: string | null = null;
  private since = 0;

  constructor(private readonly now: () => number) {}

  /** The label drawn now; a new or changed one starts the wait again. */
  show(label: string | null): void {
    if (label === this.label) return;
    this.label = label;
    this.since = this.now();
  }

  click(): boolean {
    return this.label !== null && this.now() - this.since >= PUT_ARM_MS;
  }
}

/** What a consent card asks, for a PutGuard: a new card or a changed one is new under the pointer. */
export function consentKey(s: Pick<ConsentState, 'serial' | 'action' | 'text' | 'detail' | 'always'>): string {
  return JSON.stringify([s.serial ?? 0, s.action, s.text, s.detail, s.always]);
}

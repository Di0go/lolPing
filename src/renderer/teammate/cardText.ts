import type { Strings } from '../../shared/i18n';
import { MATE_COPY_MAX, type CardState } from '../../shared/teammateIpc';

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

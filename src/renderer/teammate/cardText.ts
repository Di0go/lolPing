import type { Strings } from '../../shared/i18n';
import { MATE_COPY_MAX, type CardState } from '../../shared/teammateIpc';

/** The card's answers for Copy, cut to what the main process accepts, so a Copy is never refused. */
export function copyAllText(entries: CardState['entries']): string {
  return entries.filter((e) => e.kind === 'answer').map((e) => e.markdown).join('\n\n').slice(0, MATE_COPY_MAX);
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

import type { Lang } from '../i18n';

const LIMIT: Record<Lang, number> = { en: 90, 'zh-CN': 45 };
const SENTENCE_END = /[.!?。！？]/;

/** Cuts a reply into the one line the bubble shows and the rest the card keeps. */
export function splitLine(text: string, lang: Lang): { line: string; rest: string } {
  const body = text.trim();
  const limit = LIMIT[lang];
  if (body.length <= limit) return { line: body, rest: '' };

  for (let i = limit - 1; i > 0; i--) {
    if (!SENTENCE_END.test(body[i])) continue;
    // In English a full stop inside "3.5" or "e.g." is not a sentence end.
    const next = body[i + 1];
    if (lang === 'en' && next !== undefined && !/\s/.test(next)) continue;
    return { line: body.slice(0, i + 1), rest: body.slice(i + 1).trim() };
  }

  // The ellipsis counts toward the limit.
  const room = limit - 1;
  let cut = room;
  if (lang === 'en') {
    const space = body.lastIndexOf(' ', room);
    if (space > 0) cut = space;
  }
  return { line: `${body.slice(0, cut).trimEnd()}…`, rest: body.slice(cut).trim() };
}

/** How long the bubble stays: 6 s plus 1 s for every 15 characters. */
export function bubbleMs(line: string): number {
  return 6_000 + Math.floor(line.length / 15) * 1_000;
}

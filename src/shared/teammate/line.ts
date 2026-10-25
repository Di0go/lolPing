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

const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+/;

/** One Markdown block as plain text: no code, tables, images or marks, links as their text, on one line. */
function plainBlock(block: string): string {
  const lines = block.split('\n').filter((l) => !/^\s*\|/.test(l)); // a table row
  // A list is one block: its first item is the part that reads as a line.
  const next = lines.findIndex((l, i) => i > 0 && LIST_ITEM.test(l));
  const first = LIST_ITEM.test(lines[0] ?? '') && next > 0 ? lines.slice(0, next) : lines;
  return first
    .map((l) => l.replace(/^\s*(?:#{1,6}\s+|[-*+]\s+|\d+[.)]\s+|>\s?)/, ''))
    .join(' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\*\*|__|\*|`/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The bubble's line for an answer that came only as Markdown: the start of its first block of prose. */
export function lineFromMarkdown(markdown: string, lang: Lang): string {
  const prose = markdown.replace(/```[\s\S]*?(?:```|$)/g, '\n\n');
  const first = prose.split(/\n\s*\n/).map(plainBlock).find((b) => b !== '') ?? '';
  return splitLine(first, lang).line;
}

/** How long the bubble stays: 6 s plus 1 s for every 15 characters. */
export function bubbleMs(line: string): number {
  return 6_000 + Math.floor(line.length / 15) * 1_000;
}

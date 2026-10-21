/** What one page counts for when a budget is given in pages. */
export const PAGE_CHARS = 3000;

const SHINGLE = 12;
const STEP = 4;

/** NFKC, lower case, and every run of whitespace and punctuation as one space, so screen and file text compare. */
export function normalize(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/[\s\p{P}]+/gu, ' ').trim();
}

/** Fixed-length slices of the visible text: a Chinese line has no word breaks, and one odd character spoils few. */
function shingles(text: string): string[] {
  if (text.length <= SHINGLE) return text ? [text] : [];
  const out: string[] = [];
  for (let i = 0; i + SHINGLE <= text.length; i += STEP) out.push(text.slice(i, i + SHINGLE));
  return out;
}

/**
 * The sections (inclusive indexes) of a long file that the on-screen text most likely comes from, widened with
 * neighbours up to `budgetChars`. With nothing to match on, the start of the file.
 */
export function locate(
  sections: readonly { text: string }[],
  visible: string,
  budgetChars: number,
): { from: number; to: number } | null {
  if (sections.length === 0) return null;
  const pieces = shingles(normalize(visible));
  let best = -1;
  let bestScore = 0;
  if (pieces.length > 0) {
    sections.forEach((s, i) => {
      const hay = normalize(s.text);
      const score = pieces.reduce((n, p) => (hay.includes(p) ? n + 1 : n), 0);
      if (score > bestScore) { best = i; bestScore = score; }
    });
  }
  const start = best < 0 ? 0 : best;
  let from = start;
  let to = start;
  let total = sections[start].text.length;
  // Next first, then back, alternating; a side that is used up or too big to fit is closed and the other goes on.
  let forward = true;
  let nextOpen = true;
  let prevOpen = best >= 0;
  while (nextOpen || prevOpen) {
    const goForward: boolean = forward;
    forward = !forward;
    if (goForward ? !nextOpen : !prevOpen) continue;
    const i: number = goForward ? to + 1 : from - 1;
    const len: number | undefined = sections[i]?.text.length;
    if (len === undefined || total + len > budgetChars) {
      if (goForward) nextOpen = false; else prevOpen = false;
      continue;
    }
    total += len;
    if (goForward) to = i; else from = i;
  }
  return { from, to };
}

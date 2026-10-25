import DOMPurify from 'dompurify';
import { marked } from 'marked';

/** Text, lists, code and tables only: no images (they would load from the web), no forms, frames, SVG or styles. */
const ALLOWED_TAGS = [
  'p', 'br', 'hr', 'strong', 'em', 'del', 's', 'code', 'pre', 'blockquote', 'ul', 'ol', 'li', 'a',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'span',
];
const ALLOWED_ATTR = ['href', 'start'];

/**
 * The model's Markdown as safe HTML for the card. A link keeps its text but loses its href: a web link gets
 * `data-link`, which the card turns into a `link` action (opened only after the user's consent); any other link is
 * left as plain text.
 */
export function renderMarkdown(md: string): string {
  const html = marked.parse(md, { async: false, gfm: true });
  const root = document.createElement('div');
  root.innerHTML = DOMPurify.sanitize(html, { ALLOWED_TAGS, ALLOWED_ATTR, ALLOW_DATA_ATTR: false });
  for (const a of [...root.querySelectorAll('a')]) {
    const url = webLink(a.getAttribute('href'));
    if (url) {
      a.removeAttribute('href');
      a.setAttribute('data-link', url);
    } else {
      a.replaceWith(...a.childNodes);
    }
  }
  return root.innerHTML;
}

function webLink(href: string | null): string | null {
  if (!href) return null;
  try {
    const u = new URL(href);
    return u.protocol === 'https:' || u.protocol === 'http:' ? href : null;
  } catch {
    return null;
  }
}

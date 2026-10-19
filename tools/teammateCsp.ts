import type { Plugin } from 'vite';

/**
 * The teammate page shows the model's Markdown, so its built page gets a strict script policy. Styles stay inline:
 * Fluent's Griffel inserts its rules in <style> tags at runtime.
 */
export const TEAMMATE_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

/**
 * Adds the policy to the built teammate page only. Not in development: the React plugin's dev preamble is an inline
 * script, which this policy would block.
 */
export function teammateCsp(): Plugin {
  return {
    name: 'lolping-teammate-csp',
    apply: 'build',
    transformIndexHtml(html, ctx) {
      if (!ctx.path.endsWith('/teammate/index.html')) return html;
      return html.replace(
        /(<meta charset="utf-8" \/>)/,
        `$1\n    <meta http-equiv="Content-Security-Policy" content="${TEAMMATE_CSP}" />`,
      );
    },
  };
}

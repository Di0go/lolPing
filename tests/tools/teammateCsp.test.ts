import { describe, expect, it } from 'vitest';
import { TEAMMATE_CSP, teammateCsp } from '../../tools/teammateCsp';

const page = '<!doctype html>\n<html lang="en">\n  <head>\n    <meta charset="utf-8" />\n  </head>\n</html>';

type Transform = (html: string, ctx: { path: string }) => string;

describe('teammateCsp', () => {
  it('adds the policy to the built teammate page only', () => {
    const plugin = teammateCsp();
    expect(plugin.apply).toBe('build');
    const transform = plugin.transformIndexHtml as Transform;
    const out = transform(page, { path: '/teammate/index.html' });
    expect(out).toContain(`<meta http-equiv="Content-Security-Policy" content="${TEAMMATE_CSP}" />`);
    expect(out.indexOf('Content-Security-Policy')).toBeGreaterThan(out.indexOf('charset'));
    expect(transform(page, { path: '/settings/index.html' })).toBe(page);
  });

  it('allows no inline or outside scripts and no outside images', () => {
    const rules = new Map(TEAMMATE_CSP.split(';').map((r) => {
      const [name, ...values] = r.trim().split(/\s+/);
      return [name, values] as const;
    }));
    expect(rules.get('script-src')).toEqual(["'self'"]);
    expect(rules.get('img-src')).toEqual(["'self'"]);
    expect(rules.get('default-src')).toEqual(["'self'"]);
    expect(rules.get('object-src')).toEqual(["'none'"]);
  });
});

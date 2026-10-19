// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { renderMarkdown } from '../../src/renderer/teammate/markdown';

const parse = (html: string): HTMLElement => {
  const div = document.createElement('div');
  div.innerHTML = html;
  return div;
};

describe('renderMarkdown', () => {
  it('removes scripts, images and inline handlers', () => {
    const html = renderMarkdown([
      'Hello **there**',
      '',
      '<script>alert(1)</script>',
      '![x](https://evil.example/track.png)',
      '<img src="https://evil.example/a.png" onerror="alert(2)">',
      '<p onclick="alert(3)" style="color:red">click</p>',
      '<iframe src="https://evil.example"></iframe>',
      '<svg><circle onload="alert(4)"/></svg>',
    ].join('\n'));
    const el = parse(html);
    expect(el.querySelector('strong')?.textContent).toBe('there');
    expect(el.querySelector('script, img, iframe, svg, style')).toBeNull();
    expect(el.querySelector('[onclick], [onerror], [onload], [style], [src]')).toBeNull();
    expect(html).not.toMatch(/alert\(/);
  });

  it('turns links into link actions', () => {
    const el = parse(renderMarkdown(
      'See [docs](https://example.com/docs) and [bad](javascript:alert(1)) or <https://a.example> <span data-link="javascript:x">s</span>',
    ));
    const links = [...el.querySelectorAll('[data-link]')];
    expect(links.map((a) => a.getAttribute('data-link'))).toEqual(['https://example.com/docs', 'https://a.example']);
    expect(el.querySelector('[href]')).toBeNull();
    expect(el.textContent).toContain('bad');
  });

  it('keeps code blocks and tables', () => {
    const el = parse(renderMarkdown('```js\nconst a = 1 < 2;\n```\n\n| a | b |\n| - | - |\n| 1 | 2 |'));
    expect(el.querySelector('pre code')?.textContent).toBe('const a = 1 < 2;\n');
    expect(el.querySelectorAll('td')).toHaveLength(2);
  });
});

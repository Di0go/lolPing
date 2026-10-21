import { describe, expect, it } from 'vitest';
import { applyLimits, parseToolCall, toolDefs, type ToolCall } from '../../../src/shared/teammate/tools';
import { EMOTE_CATALOG } from '../../../src/shared/emoteCatalog';

const ping = (n: number): ToolCall => ({ tool: 'ping', type: 'danger', at: { x: n, y: n } });

describe('tools', () => {
  it('parses each tool from a JSON string or an object', () => {
    expect(parseToolCall('say', { text: '  hi  ' })).toEqual({ tool: 'say', text: 'hi' });
    expect(parseToolCall('say', '{"text":"hi"}')).toEqual({ tool: 'say', text: 'hi' });
    expect(parseToolCall('ping', { type: 'danger', x: 10, y: 20, order: 2 })).toEqual({
      tool: 'ping', type: 'danger', at: { x: 10, y: 20 }, order: 2,
    });
    expect(parseToolCall('ping', '{"type":"push","spot":3,"label":" here "}')).toEqual({
      tool: 'ping', type: 'push', at: { spot: 3 }, label: 'here',
    });
    expect(parseToolCall('emote', { slug: EMOTE_CATALOG[0].slug, x: 1, y: 2 })).toEqual({
      tool: 'emote', slug: EMOTE_CATALOG[0].slug, at: { x: 1, y: 2 },
    });
    expect(parseToolCall('answer', { markdown: '# A' })).toEqual({ tool: 'answer', markdown: '# A' });
    expect(parseToolCall('look', { x: 1, y: 2, w: 300, h: 200 })).toEqual({ tool: 'look', x: 1, y: 2, w: 300, h: 200 });
  });

  it('reads spot and x, y targets and an old mark as a spot', () => {
    expect(parseToolCall('ping', { type: 'danger', spot: 2 })).toMatchObject({ at: { spot: 2 } });
    expect(parseToolCall('ping', { type: 'danger', mark: 1 })).toMatchObject({ at: { spot: 1 } });
    expect(parseToolCall('ping', { type: 'danger', x: 5, y: 6, spot: 1 })).toMatchObject({ at: { x: 5, y: 6 } });
    expect(parseToolCall('emote', { slug: EMOTE_CATALOG[0].slug, spot: 1 })).toMatchObject({ at: { spot: 1 } });
    expect(parseToolCall('ping', { type: 'danger', spot: 0 })).toBeNull();
    expect(parseToolCall('ping', { type: 'danger', spot: 1.5 })).toBeNull();
  });

  it('parses read_file pages and search', () => {
    expect(parseToolCall('read_file', { pages: '3' })).toEqual({ tool: 'read_file', pages: { from: 3, to: 3 } });
    expect(parseToolCall('read_file', { pages: '3-5' })).toEqual({ tool: 'read_file', pages: { from: 3, to: 5 } });
    expect(parseToolCall('read_file', { search: ' invoice total ' })).toEqual({
      tool: 'read_file', search: 'invoice total',
    });
    expect(parseToolCall('read_file', { pages: '2', search: 'x' })).toEqual({
      tool: 'read_file', pages: { from: 2, to: 2 }, search: 'x',
    });
    expect(parseToolCall('read_file', { search: 'x'.repeat(300) })).toEqual({
      tool: 'read_file', search: 'x'.repeat(200),
    });
    expect(parseToolCall('read_file', {})).toBeNull();
    expect(parseToolCall('read_file', { pages: '0' })).toBeNull();
    expect(parseToolCall('read_file', { pages: '5-3' })).toBeNull();
    expect(parseToolCall('read_file', { pages: 'abc' })).toBeNull();
    expect(parseToolCall('read_file', { pages: 'abc', search: 'x' })).toEqual({ tool: 'read_file', search: 'x' });
  });

  it('takes a page given as a number, as models often send it', () => {
    expect(parseToolCall('read_file', { pages: 3 })).toEqual({ tool: 'read_file', pages: { from: 3, to: 3 } });
    expect(parseToolCall('read_file', { pages: 0 })).toBeNull();
    expect(parseToolCall('read_file', { pages: -2 })).toBeNull();
    expect(parseToolCall('read_file', { pages: 2.5 })).toBeNull();
    expect(parseToolCall('read_file', { pages: Number.NaN })).toBeNull();
  });

  it('offers read_file only with a file', () => {
    const names = (file: boolean) => toolDefs({ emotes: true, spots: 1, file, look: true }).map((d) => d.name);
    expect(names(true)).toContain('read_file');
    expect(names(false)).not.toContain('read_file');
    const ping = toolDefs({ emotes: false, spots: 1, file: false, look: true }).find((d) => d.name === 'ping');
    const props = Object.keys((ping?.parameters.properties ?? {}) as object);
    expect(props).toEqual(expect.arrayContaining(['x', 'y', 'spot']));
    expect(props).not.toContain('mark');
  });

  it('rejects unknown tools and wrong argument types', () => {
    expect(parseToolCall('ping', { type: 'danger', x: 'a', y: 1 })).toBeNull();
    expect(parseToolCall('rm', {})).toBeNull();
    expect(parseToolCall('say', '{not json')).toBeNull();
    expect(parseToolCall('say', { text: 5 })).toBeNull();
    expect(parseToolCall('say', { text: '   ' })).toBeNull();
    expect(parseToolCall('say', null)).toBeNull();
    expect(parseToolCall('ping', { type: 'nope', x: 1, y: 1 })).toBeNull();
    expect(parseToolCall('ping', { type: 'danger', x: Number.NaN, y: 1 })).toBeNull();
    expect(parseToolCall('ping', { type: 'danger' })).toBeNull();
    expect(parseToolCall('emote', { slug: 'not_an_emote', x: 1, y: 1 })).toBeNull();
    expect(parseToolCall('look', { x: 1, y: 2, w: 0, h: 5 })).toBeNull();
  });

  it('cuts text and answers to their limits', () => {
    expect(parseToolCall('say', { text: 'a'.repeat(900) })).toEqual({ tool: 'say', text: 'a'.repeat(600) });
    expect(parseToolCall('answer', { markdown: 'a'.repeat(30000) })).toEqual({
      tool: 'answer', markdown: 'a'.repeat(20000),
    });
  });

  it('cuts labels to 20 characters', () => {
    const call = parseToolCall('ping', { type: 'danger', x: 1, y: 1, label: 'x'.repeat(200) });
    expect(call).toMatchObject({ tool: 'ping', label: 'x'.repeat(20) });
  });

  it('drops omw and over-limit pings', () => {
    expect(parseToolCall('ping', { type: 'omw', x: 1, y: 1 })).toBeNull();
    expect(parseToolCall('ping', { type: 'missingflip', x: 1, y: 1 })).toBeNull();
    const slug = EMOTE_CATALOG[0].slug;
    const calls: ToolCall[] = [
      ...Array.from({ length: 9 }, (_, i) => ping(i)),
      { tool: 'emote', slug, at: { x: 1, y: 1 } },
      { tool: 'emote', slug, at: { x: 2, y: 2 } },
      { tool: 'say', text: 'hi' },
      { tool: 'answer', markdown: 'a' },
    ];
    const out = applyLimits(calls);
    expect(out.filter((c) => c.tool === 'ping')).toEqual(calls.slice(0, 6));
    expect(out.filter((c) => c.tool === 'emote')).toHaveLength(1);
    expect(out.map((c) => c.tool).slice(-2)).toEqual(['say', 'answer']);
  });

  it('offers look only when the ask may use it', () => {
    expect(toolDefs({ emotes: false, spots: 1, file: false, look: false }).map((t) => t.name))
      .toEqual(['say', 'ping', 'answer']);
  });

  it('leaves emote out of the tool list when emotes are off', () => {
    expect(toolDefs({ emotes: false, spots: 1, file: false, look: true }).map((t) => t.name))
      .toEqual(['say', 'ping', 'answer', 'look']);
    const on = toolDefs({ emotes: true, spots: 1, file: false, look: true });
    expect(on.map((t) => t.name)).toContain('emote');
    const params = on.find((t) => t.name === 'ping')?.parameters as { properties: { type: { enum: string[] } } };
    expect(params.properties.type.enum).not.toContain('omw');
    expect(params.properties.type.enum).not.toContain('missingflip');
  });
});

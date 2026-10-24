import { describe, expect, it } from 'vitest';
import {
  CONSENT_TOOL, applyLimits, parseConsent, parseToolCall, toolDefs, visitorToolDefs, type ToolCall,
} from '../../../src/shared/teammate/tools';
import { EMOTE_CATALOG } from '../../../src/shared/emoteCatalog';

const OFF = { emotes: false, spots: 1, file: false, look: false, kind: 'answer', form: false, selection: false } as const;
type Opts = Parameters<typeof toolDefs>[0];
const names = (o: Partial<Opts> = {}): string[] => toolDefs({ ...OFF, ...o }).map((d) => d.name);
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
    expect(names({ file: true })).toContain('read_file');
    expect(names({ file: false })).not.toContain('read_file');
    const ping = toolDefs({ ...OFF, look: true }).find((d) => d.name === 'ping');
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
    expect(names()).toEqual(['say', 'ping', 'answer', 'open']);
  });

  it('leaves emote out of the tool list when emotes are off', () => {
    expect(names({ look: true })).toEqual(['say', 'ping', 'answer', 'look', 'open']);
    const on = toolDefs({ ...OFF, emotes: true, look: true });
    expect(on.map((t) => t.name)).toContain('emote');
    const params = on.find((t) => t.name === 'ping')?.parameters as { properties: { type: { enum: string[] } } };
    expect(params.properties.type.enum).not.toContain('omw');
    expect(params.properties.type.enum).not.toContain('missingflip');
  });

  it('parses copy text and copy table', () => {
    expect(parseToolCall('copy', { text: 'Grabbed\n  text' })).toEqual({ tool: 'copy', text: 'Grabbed\n  text' });
    expect(parseToolCall('copy', { table: [['a', 'b'], ['1']] })).toEqual({
      tool: 'copy', table: [['a', 'b'], ['1', '']],
    });
    expect(parseToolCall('copy', { text: 'x', table: [['a']] })).toEqual({ tool: 'copy', table: [['a']] });
    expect(parseToolCall('copy', { text: '   ' })).toBeNull();
    expect(parseToolCall('copy', { text: 'a'.repeat(20_001) })).toBeNull();
    expect(parseToolCall('copy', { text: 'a'.repeat(20_000) })).toMatchObject({ tool: 'copy' });
    expect(parseToolCall('copy', { table: [] })).toBeNull();
    expect(parseToolCall('copy', { table: Array.from({ length: 51 }, () => ['x']) })).toBeNull();
    expect(parseToolCall('copy', {})).toBeNull();
  });

  it('parses paste with a mode and drops text over 20,000 characters', () => {
    expect(parseToolCall('paste', { text: '  Hi\n', mode: 'replace' })).toEqual({
      tool: 'paste', text: '  Hi\n', mode: 'replace',
    });
    expect(parseToolCall('paste', { text: 'Hi' })).toEqual({ tool: 'paste', text: 'Hi', mode: 'insert' });
    expect(parseToolCall('paste', { text: 'Hi', mode: 'append' })).toBeNull();
    expect(parseToolCall('paste', { text: '\n' })).toBeNull();
    expect(parseToolCall('paste', { text: 'a'.repeat(20_001), mode: 'insert' })).toBeNull();
  });

  it('parses fill, keeping the last value for an id listed twice', () => {
    const twice = { fields: [{ id: 'a', value: '1' }, { id: 'b', value: 'on' }, { id: 'a', value: '2' }] };
    expect(parseToolCall('fill', twice)).toEqual({
      tool: 'fill', fields: [{ id: 'a', value: '2' }, { id: 'b', value: 'on' }],
    });
    expect(parseToolCall('fill', { fields: [{ id: 'n', value: 3 }, { id: 'e', value: '' }] })).toEqual({
      tool: 'fill', fields: [{ id: 'n', value: '3' }, { id: 'e', value: '' }],
    });
    expect(parseToolCall('fill', '{"fields":[{"id":"a","value":"x"}]}')).toMatchObject({ tool: 'fill' });
    expect(parseToolCall('fill', { fields: [] })).toBeNull();
    expect(parseToolCall('fill', { fields: [{ id: '', value: 'x' }] })).toBeNull();
    expect(parseToolCall('fill', { fields: [{ id: 'a' }] })).toBeNull();
    expect(parseToolCall('fill', { fields: 'a' })).toBeNull();
    const many = Array.from({ length: 61 }, (_, i) => ({ id: `f${i}`, value: 'x' }));
    expect(parseToolCall('fill', { fields: many })).toBeNull();
    expect(parseToolCall('fill', { fields: many.slice(0, 60) })).toMatchObject({ tool: 'fill' });
  });

  it('drops a fill with a value over 2,000 characters but keeps the rest of the answer', () => {
    expect(parseToolCall('fill', { fields: [{ id: 'a', value: 'x'.repeat(2001) }] })).toBeNull();
    expect(parseToolCall('fill', { fields: [{ id: 'a', value: 'x'.repeat(2000) }] })).toMatchObject({ tool: 'fill' });
    const calls = [
      parseToolCall('fill', { fields: [{ id: 'a', value: 'x'.repeat(2001) }] }),
      parseToolCall('say', { text: 'Filled it' }),
      parseToolCall('answer', { markdown: 'Name: Sam' }),
    ].filter((c): c is ToolCall => c !== null);
    expect(applyLimits(calls).map((c) => c.tool)).toEqual(['say', 'answer']);
  });

  it('parses event and drops one that is invalid or over its limits', () => {
    expect(parseToolCall('event', { title: ' Dinner ', start: '2026-11-05T19:00', end: '2026-11-05T21:00' })).toEqual({
      tool: 'event', title: 'Dinner', start: '2026-11-05T19:00', end: '2026-11-05T21:00',
    });
    expect(parseToolCall('event', {
      title: 'Trip', start: '2026-11-05', end: '2026-11-07', location: 'Lisbon', notes: 'Bring a coat', extra: 1,
    })).toEqual({
      tool: 'event', title: 'Trip', start: '2026-11-05', end: '2026-11-07', location: 'Lisbon', notes: 'Bring a coat',
    });
    expect(parseToolCall('event', { title: 'A', start: '2026-11-05', end: '', location: '' })).toEqual({
      tool: 'event', title: 'A', start: '2026-11-05',
    });
    expect(parseToolCall('event', { title: '', start: '2026-11-05' })).toBeNull();
    expect(parseToolCall('event', { title: 'A', start: 'tomorrow' })).toBeNull();
    expect(parseToolCall('event', { title: 'A', start: '2026-02-30' })).toBeNull();
    expect(parseToolCall('event', { title: 'A', start: '2026-11-05T10:00', end: '2026-11-05T09:00' })).toBeNull();
    expect(parseToolCall('event', { title: 'a'.repeat(201), start: '2026-11-05' })).toBeNull();
    expect(parseToolCall('event', { title: 'a'.repeat(200), start: '2026-11-05' })).toMatchObject({ tool: 'event' });
    expect(parseToolCall('event', { title: 'A', start: '2026-11-05', location: 'l'.repeat(201) })).toBeNull();
    expect(parseToolCall('event', { title: 'A', start: '2026-11-05', notes: 'n'.repeat(2001) })).toBeNull();
    expect(parseToolCall('event', { title: 'A', start: '2026-11-05', notes: 'n'.repeat(2000) })).toMatchObject({
      tool: 'event',
    });
  });

  it('accepts only http and https URLs for open', () => {
    expect(parseToolCall('open', { url: ' https://example.com/a?b=1 ' })).toEqual({
      tool: 'open', url: 'https://example.com/a?b=1',
    });
    expect(parseToolCall('open', { url: 'http://localhost:3000' })).toMatchObject({ tool: 'open' });
    for (const url of [
      'file:///C:/Windows/System32/calc.exe', 'javascript:alert(1)', 'ms-settings:privacy', 'mailto:a@b.c',
      'data:text/html,hi', 'example.com', '//example.com', '', 'https://', 'C:\\Windows\\notepad.exe',
    ]) expect(parseToolCall('open', { url })).toBeNull();
    expect(parseToolCall('open', { url: `https://example.com/${'a'.repeat(2000)}` })).toBeNull();
    expect(parseToolCall('open', { url: 5 })).toBeNull();
  });

  it('offers paste and fill only for act asks', () => {
    for (const kind of ['answer', 'continue', 'guide', 'grab', 'words', 'save'] as const) {
      expect(names({ kind, form: true })).not.toContain('paste');
      expect(names({ kind, form: true })).not.toContain('fill');
    }
    expect(names({ kind: 'act' })).toContain('paste');
    expect(names({ kind: 'act', form: true })).toEqual(expect.arrayContaining(['paste', 'fill']));
  });

  it('offers fill only when form fields were read', () => {
    expect(names({ kind: 'act', form: false })).not.toContain('fill');
    expect(names({ kind: 'act', form: true })).toContain('fill');
  });

  it('offers copy for grab and act, event for grab, and open for every kind', () => {
    for (const kind of ['answer', 'continue', 'guide', 'act', 'grab', 'words', 'save'] as const) {
      const offered = names({ kind });
      expect(offered).toContain('open');
      expect(offered.includes('copy')).toBe(kind === 'grab' || kind === 'act');
      expect(offered.includes('event')).toBe(kind === 'grab');
    }
  });

  it('tells the model how checkboxes, radios and all-day events work', () => {
    const fill = toolDefs({ ...OFF, kind: 'act', form: true }).find((d) => d.name === 'fill');
    expect(fill?.description).toMatch(/`on` or `off`/);
    expect(fill?.description).toMatch(/radio/);
    const event = toolDefs({ ...OFF, kind: 'grab' }).find((d) => d.name === 'event');
    expect(event?.description).toMatch(/last day/);
  });

  it('offers a replace only when text was selected at the ask', () => {
    const modes = (selection: boolean): unknown => {
      const paste = toolDefs({ ...OFF, kind: 'act', selection }).find((d) => d.name === 'paste');
      const props = paste?.parameters.properties as Record<string, { enum?: string[] }> | undefined;
      return props?.mode.enum;
    };
    expect(modes(true)).toEqual(['insert', 'replace']);
    expect(modes(false)).toEqual(['insert']);
  });

  it('tells the model an insert adds only the new text, never what is already there', () => {
    for (const selection of [true, false]) {
      const paste = toolDefs({ ...OFF, kind: 'act', selection }).find((d) => d.name === 'paste');
      expect(paste?.description).toMatch(/only the new text/);
    }
  });

  it('says a copy happens at once, with no question to the user', () => {
    const copy = toolDefs({ ...OFF, kind: 'grab' }).find((d) => d.name === 'copy');
    expect(copy?.description).not.toMatch(/agrees/);
    expect(copy?.description).toMatch(/at once/);
  });

  it('refuses a second paste in one answer', () => {
    const paste = (text: string): ToolCall => ({ tool: 'paste', text, mode: 'insert' });
    const fill: ToolCall = { tool: 'fill', fields: [{ id: 'a', value: 'x' }] };
    const event: ToolCall = { tool: 'event', title: 'A', start: '2026-11-05' };
    const open = (n: number): ToolCall => ({ tool: 'open', url: `https://example.com/${n}` });
    const calls = [paste('one'), paste('two'), fill, fill, event, event, open(1), open(2), open(3), open(4)];
    expect(applyLimits(calls)).toEqual([calls[0], calls[2], calls[4], calls[6], calls[7], calls[8]]);
  });
});

describe('consent tool', () => {
  it('asks for the tool and its input, and the id when there is one', () => {
    expect(CONSENT_TOOL.name).toBe('consent');
    expect(CONSENT_TOOL.description).toMatch(/permission/);
    expect(CONSENT_TOOL.parameters).toMatchObject({
      type: 'object', required: ['tool_name', 'input'],
      properties: { tool_name: { type: 'string' }, input: { type: 'object' }, tool_use_id: { type: 'string' } },
    });
  });

  it('reads the tool name and input of a permission prompt', () => {
    const input = { file_path: 'src/app.ts', old_string: 'a', new_string: 'b' };
    expect(parseConsent({ tool_name: 'Edit', input })).toEqual({ tool: 'Edit', input });
    expect(parseConsent({ tool_name: 'mcp__lolping__say', input: {}, tool_use_id: 'toolu_1' }))
      .toEqual({ tool: 'mcp__lolping__say', input: {} });
  });

  it('refuses a name no permission key can carry and an input that is not an object', () => {
    for (const tool_name of ['', 'a b', 'a:b', 'x'.repeat(65), 'Ed\nit', 5, null]) {
      expect(parseConsent({ tool_name, input: {} }), String(tool_name)).toBeNull();
    }
    expect(parseConsent({ tool_name: 'Edit' })).toBeNull();
    expect(parseConsent({ tool_name: 'Edit', input: 'x' })).toBeNull();
    expect(parseConsent({ tool_name: 'Edit', input: null })).toBeNull();
    expect(parseConsent(null)).toBeNull();
    expect(parseConsent('Edit')).toBeNull();
    expect(parseConsent({ tool_name: 'x'.repeat(64), input: {} })?.tool).toBe('x'.repeat(64));
  });
});

describe('visitorToolDefs', () => {
  const props = (name: string, emotes = true): string[] => {
    const def = visitorToolDefs(emotes).find((d) => d.name === name);
    return Object.keys((def?.parameters.properties ?? {}) as Record<string, unknown>);
  };

  it('offers only say, ping, emote and answer', () => {
    expect(visitorToolDefs(true).map((d) => d.name)).toEqual(['say', 'ping', 'emote', 'answer']);
  });

  it('leaves out the emote when emotes are off', () => {
    expect(visitorToolDefs(false).map((d) => d.name)).toEqual(['say', 'ping', 'answer']);
  });

  it('has no position on a ping or an emote, since lolPing places them at the cursor', () => {
    expect(props('ping')).toEqual(['type', 'label', 'order']);
    expect(props('emote')).toEqual(['slug']);
  });

  it('describes the tools as the asks do', () => {
    const asks = toolDefs({ ...OFF, spots: 0, emotes: true });
    for (const def of visitorToolDefs(true)) {
      expect(def.description).toBe(asks.find((d) => d.name === def.name)?.description);
    }
  });
});

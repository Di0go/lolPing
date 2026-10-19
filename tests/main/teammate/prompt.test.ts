import { describe, expect, it } from 'vitest';
import { firstTurn, systemPrompt, type AskContext } from '../../../src/main/teammate/prompt';
import { intentFor } from '../../../src/shared/teammate/intents';
import { DEFAULT_TEAMMATE } from '../../../src/shared/teammate/settings';
import type { ThreadRecord } from '../../../src/shared/teammate/history';

const jpeg = (n: number): Buffer => Buffer.from([0xff, 0xd8, n]);

function ctx(over: Partial<AskContext> = {}): AskContext {
  return {
    lang: 'en',
    intent: intentFor(DEFAULT_TEAMMATE, 'missing', 'en'),
    words: null,
    app: 'Notepad',
    title: 'notes.txt',
    shot: {
      display: { x: 0, y: 0, w: 3200, h: 1800 },
      overview: { w: 1600, h: 900 },
      zooms: [{ x: 1100, y: 525, w: 1000, h: 750 }],
    },
    overviewJpeg: jpeg(1),
    zoomJpegs: [jpeg(2)],
    thread: null,
    instructions: '',
    emotes: false,
    ...over,
  };
}

const entry = (at: number, line: string): ThreadRecord['entries'][number] => ({
  at, intent: 'missing', words: null, line, markdown: '', thumb: jpeg(9).toString('base64'),
});
const thread = (entries: ThreadRecord['entries']): ThreadRecord => ({
  id: 't', title: 't', started: 0, lastActivity: 0, app: 'a', windowTitle: 'w', profile: 'p', entries,
});

describe('teammate prompt', () => {
  it('puts the intent instruction and the user\'s instructions in the system prompt', () => {
    const c = ctx({ instructions: 'Call me Sam.' });
    const s = systemPrompt(c);
    expect(s).toContain(c.intent.instruction);
    expect(s).toMatch(/The user's own instructions\nCall me Sam\./);
    expect(systemPrompt(ctx())).not.toContain("The user's own instructions");
  });

  it('forbids omw and lists the teammate vocabulary', () => {
    const s = systemPrompt(ctx());
    expect(s).toMatch(/Never use `omw`/);
    expect(s).not.toMatch(/^- omw:/m);
    for (const id of ['danger', 'assist', 'missing', 'needvision', 'push', 'allin', 'enemyvision', 'bait',
      'visioncleared', 'generic']) {
      expect(s).toContain(`- ${id}:`);
    }
    expect(s).toMatch(/Call `say` first/);
  });

  it('asks for the app language except when translating', () => {
    expect(systemPrompt(ctx({ lang: 'zh-CN' }))).toContain('Answer in 简体中文');
    const tr = systemPrompt(ctx({ intent: intentFor(DEFAULT_TEAMMATE, 'missingflip', 'en') }));
    expect(tr).not.toContain('Answer in English');
    expect(tr).toContain('the language the task asks for');
  });

  it('lists emotes only when they are on', () => {
    expect(systemPrompt(ctx())).not.toContain('Emotes:');
    expect(systemPrompt(ctx({ emotes: true }))).toContain('facepalm');
  });

  it('sends the overview then each zoom as JPEG parts', () => {
    const t = firstTurn(ctx({ words: 'what is this', zoomJpegs: [jpeg(2), jpeg(3)] }));
    expect(t.role).toBe('user');
    if (t.role !== 'user') return;
    const [text, ...images] = t.parts;
    const body = 'text' in text ? text.text : '';
    expect(body).toContain('what is this');
    expect(body).toContain('1600 x 900');
    expect(body).toContain('x=800, y=450');
    expect(images.map((p) => ('image' in p ? [p.image.mime, p.image.data[2]] : null)))
      .toEqual([['image/jpeg', 1], ['image/jpeg', 2], ['image/jpeg', 3]]);
  });

  it('drops the oldest thread turns past the budget', () => {
    const entries = Array.from({ length: 20 }, (_, i) => entry(i, `line ${i}`));
    const t = firstTurn(ctx({ thread: thread(entries) }));
    if (t.role !== 'user') throw new Error('user turn expected');
    const earlier = t.parts.flatMap((p) => ('text' in p && p.text.startsWith('Earlier ask') ? [p.text] : []));
    expect(earlier.length).toBeGreaterThan(0);
    expect(earlier.length).toBeLessThan(20);
    expect(earlier[0]).toContain('line 19');
    expect(earlier.join('\n')).not.toContain('line 0"');
  });
});

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { UsageLog } from '../../../src/main/teammate/usage';

const file = () => join(mkdtempSync(join(tmpdir(), 'lolping-usage-')), 'teammate', 'usage.json');
/** Noon on a day, local time, so the month never depends on the time zone the tests run in. */
const day = (y: number, m: number, d: number): number => new Date(y, m - 1, d, 12).getTime();

describe('UsageLog', () => {
  it('adds tokens to this month and starts again in a new month', async () => {
    const path = file();
    let now = day(2026, 10, 3);
    const log = new UsageLog(path, () => now);
    expect(log.month()).toEqual({ month: '2026-10', input: 0, output: 0 });
    log.add({ input: 1200, output: 80 });
    log.add({ input: 300, output: 20 });
    expect(log.month()).toEqual({ month: '2026-10', input: 1500, output: 100 });
    await log.flush();
    expect(new UsageLog(path, () => now).month()).toEqual({ month: '2026-10', input: 1500, output: 100 });

    now = day(2026, 11, 1);
    expect(log.month()).toEqual({ month: '2026-11', input: 0, output: 0 });
    log.add({ input: 10, output: 5 });
    expect(log.month()).toEqual({ month: '2026-11', input: 10, output: 5 });
    await log.flush();
    expect(new UsageLog(path, () => now).month()).toEqual({ month: '2026-11', input: 10, output: 5 });
  });

  it('starts from zero on a broken file and ignores counts that are not numbers', () => {
    const path = file();
    mkdirSync(dirname(path), { recursive: true });
    const log = new UsageLog(path, () => day(2026, 10, 3));
    for (const raw of ['not json', '{"month":"2026-10","input":-5,"output":"7"}', 'null', '[]']) {
      writeFileSync(path, raw);
      expect(new UsageLog(path, () => day(2026, 10, 3)).month()).toEqual({ month: '2026-10', input: 0, output: 0 });
    }
    log.add({ input: Number.NaN, output: -3 });
    expect(log.month()).toEqual({ month: '2026-10', input: 0, output: 0 });
  });
});

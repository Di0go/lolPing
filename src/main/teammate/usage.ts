import { readFileSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { UsageMonth } from '../../shared/ipc';
import { renameWithRetry } from '../settingsStore';

const count = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v) : 0);

/** YYYY-MM in local time: "this month" is the user's month. */
function monthOf(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function parse(text: string): UsageMonth | null {
  try {
    const raw: unknown = JSON.parse(text);
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
    const { month, input, output } = raw as Record<string, unknown>;
    if (typeof month !== 'string' || !/^\d{4}-\d{2}$/.test(month)) return null;
    return { month, input: count(input), output: count(output) };
  } catch {
    return null;
  }
}

/** The tokens the teammate's providers reported this month, kept in one small file. No prices. */
export class UsageLog {
  private data: UsageMonth;
  private writing: Promise<void> = Promise.resolve();

  constructor(private readonly file: string, private readonly now: () => number) {
    let text = '';
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      // no file yet
    }
    this.data = parse(text) ?? { month: monthOf(now()), input: 0, output: 0 };
  }

  add(u: { input: number; output: number }): void {
    const m = this.month();
    this.data = { month: m.month, input: m.input + count(u.input), output: m.output + count(u.output) };
    const snapshot = JSON.stringify(this.data);
    this.writing = this.writing.then(() => this.write(snapshot)).catch((err: unknown) => {
      console.warn('[teammate] usage:', err);
    });
  }

  month(): UsageMonth {
    const month = monthOf(this.now());
    return this.data.month === month ? { ...this.data } : { month, input: 0, output: 0 };
  }

  /** Settles once every count added so far is on disk (or failed to get there). */
  flush(): Promise<void> {
    return this.writing;
  }

  private async write(text: string): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    try {
      await writeFile(tmp, text);
      await renameWithRetry(tmp, this.file);
    } catch (err) {
      await rm(tmp, { force: true });
      throw err;
    }
  }
}

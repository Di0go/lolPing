import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { PingId } from '../../shared/pings';
import { prune, type ThreadRecord } from '../../shared/teammate/history';
import { renameWithRetry } from '../settingsStore';
import type { Crypto } from './secrets';

type Entry = ThreadRecord['entries'][number];
export type PruneRule = { keepDays: number | null; maxThreads: number };
export interface ThreadSummary {
  id: string;
  title: string;
  lastActivity: number;
  app: string;
  intents: PingId[];
}

export interface HistoryOptions {
  /** False while teammate.history.on is off or history is paused: nothing is written. */
  enabled?: () => boolean;
  /** The retention rule applied on start and after each append. */
  rule?: () => PruneRule;
}

const DEFAULT_RULE: PruneRule = { keepDays: 30, maxThreads: 500 };
const EXT = '.thread';
// Ids come from disk names and the renderer; only this shape may reach a path.
const ID_RE = /^[A-Za-z0-9-]{1,64}$/;

const isString = (v: unknown): v is string => typeof v === 'string';
const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function parseEntry(raw: unknown): Entry | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const x = raw as Record<string, unknown>;
  if (!isNumber(x.at) || !isString(x.intent) || !(x.words === null || isString(x.words))) return null;
  if (!isString(x.line) || !isString(x.markdown) || !isString(x.thumb)) return null;
  // The intent is stored as written by this app; readers treat an unknown id as plain text.
  return { at: x.at, intent: x.intent as PingId, words: x.words, line: x.line, markdown: x.markdown, thumb: x.thumb };
}

/** Validates decrypted text from disk; anything malformed is rejected rather than trusted. */
function parseThread(text: string): ThreadRecord | null {
  try {
    const raw: unknown = JSON.parse(text);
    if (typeof raw !== 'object' || raw === null) return null;
    const r = raw as Record<string, unknown>;
    if (!isString(r.id) || !ID_RE.test(r.id) || !isString(r.title) || !isNumber(r.started)) return null;
    if (!isNumber(r.lastActivity) || !isString(r.app) || !isString(r.windowTitle) || !isString(r.profile)) return null;
    if (!Array.isArray(r.entries)) return null;
    const entries: Entry[] = [];
    for (const e of r.entries as unknown[]) {
      const entry = parseEntry(e);
      if (!entry) return null;
      entries.push(entry);
    }
    return {
      id: r.id,
      title: r.title,
      started: r.started,
      lastActivity: r.lastActivity,
      app: r.app,
      windowTitle: r.windowTitle,
      profile: r.profile,
      entries,
    };
  } catch {
    return null;
  }
}

/** Threads kept on disk, one file each, encrypted through the system keychain. */
export class HistoryStore {
  private currentId: string | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly dir: string,
    private readonly crypto: Crypto,
    private readonly now: () => number,
    private readonly options: HistoryOptions = {},
  ) {
    if (this.available()) void this.prune(this.rule()).catch(() => undefined);
  }

  available(): boolean {
    return this.crypto.isEncryptionAvailable();
  }

  current(): ThreadRecord | null {
    return this.currentId === null ? null : this.readSync(this.currentId);
  }

  setCurrent(id: string | null): void {
    this.currentId = id !== null && ID_RE.test(id) ? id : null;
  }

  async append(
    threadId: string | null,
    entry: Entry,
    meta: { title: string; app: string; windowTitle: string; profile: string },
  ): Promise<ThreadRecord> {
    const writable = this.writable();
    const existing = writable && threadId !== null ? this.readSync(threadId) : null;
    const at = this.now();
    const record: ThreadRecord = existing
      ? { ...existing, lastActivity: at, entries: [...existing.entries, entry] }
      : { id: randomUUID(), ...meta, started: at, lastActivity: at, entries: [entry] };
    if (!writable) return record;
    await this.enqueue(async () => {
      await this.write(record);
      await this.pruneNow(this.rule());
    });
    this.currentId = record.id;
    return record;
  }

  async list(query?: string): Promise<ThreadSummary[]> {
    const q = query?.trim().toLowerCase() ?? '';
    const out: ThreadSummary[] = [];
    for (const t of await this.all()) {
      if (q && !this.matches(t, q)) continue;
      out.push({
        id: t.id,
        title: t.title,
        lastActivity: t.lastActivity,
        app: t.app,
        intents: t.entries.map((e) => e.intent),
      });
    }
    return out.sort((a, b) => b.lastActivity - a.lastActivity);
  }

  async get(id: string): Promise<ThreadRecord | null> {
    return this.readSync(id);
  }

  async delete(id: string): Promise<void> {
    if (!ID_RE.test(id)) return;
    await this.enqueue(() => rm(this.path(id), { force: true }));
    if (this.currentId === id) this.currentId = null;
  }

  async clear(): Promise<void> {
    await this.enqueue(async () => {
      for (const id of await this.ids()) await rm(this.path(id), { force: true });
    });
    this.currentId = null;
  }

  async prune(rule: PruneRule): Promise<void> {
    await this.enqueue(() => this.pruneNow(rule));
  }

  private matches(t: ThreadRecord, q: string): boolean {
    if (t.title.toLowerCase().includes(q)) return true;
    return t.entries.some((e) => e.line.toLowerCase().includes(q) || (e.words ?? '').toLowerCase().includes(q));
  }

  private writable(): boolean {
    return this.available() && (this.options.enabled?.() ?? true);
  }

  private rule(): PruneRule {
    return this.options.rule?.() ?? DEFAULT_RULE;
  }

  private path(id: string): string {
    return join(this.dir, id + EXT);
  }

  private readSync(id: string): ThreadRecord | null {
    if (!this.available() || !ID_RE.test(id) || !existsSync(this.path(id))) return null;
    try {
      const t = parseThread(this.crypto.decryptString(readFileSync(this.path(id))));
      return t && t.id === id ? t : null;
    } catch {
      return null;
    }
  }

  private async ids(): Promise<string[]> {
    try {
      return (await readdir(this.dir))
        .filter((f) => f.endsWith(EXT))
        .map((f) => f.slice(0, -EXT.length))
        .filter((id) => ID_RE.test(id));
    } catch {
      return [];
    }
  }

  /** Every readable thread; a file that won't decrypt or parse is skipped, not deleted. */
  private async all(): Promise<ThreadRecord[]> {
    if (!this.available()) return [];
    const out: ThreadRecord[] = [];
    for (const id of await this.ids()) {
      const t = this.readSync(id);
      if (t) out.push(t);
    }
    return out;
  }

  private async pruneNow(rule: PruneRule): Promise<void> {
    const doomed = prune(await this.all(), this.now(), rule);
    for (const id of doomed) await rm(this.path(id), { force: true });
    if (this.currentId !== null && doomed.includes(this.currentId)) this.currentId = null;
  }

  private async write(t: ThreadRecord): Promise<void> {
    const bytes = this.crypto.encryptString(JSON.stringify(t));
    await mkdir(this.dir, { recursive: true });
    const file = this.path(t.id);
    const tmp = `${file}.tmp`;
    try {
      await writeFile(tmp, bytes);
      await renameWithRetry(tmp, file);
    } catch (err) {
      await rm(tmp, { force: true });
      throw err;
    }
  }

  private enqueue<T>(job: () => Promise<T>): Promise<T> {
    const run = this.queue.then(job);
    this.queue = run.catch(() => undefined);
    return run;
  }
}

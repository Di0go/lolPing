import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isPingId, type PingId } from '../../shared/pings';
import { isSessionId, prune, spotCount, type ThreadRecord } from '../../shared/teammate/history';
import { renameWithRetry } from '../settingsStore';
import type { Crypto } from './secrets';

type Entry = ThreadRecord['entries'][number];
type AgentSession = NonNullable<ThreadRecord['agent']>;
export type PruneRule = { keepDays: number | null; maxThreads: number };
export interface ThreadSummary {
  id: string;
  title: string;
  lastActivity: number;
  app: string;
  intents: PingId[];
  /** The agent profile whose session the thread continues, for the History window's Open in button. */
  agent?: string;
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
  if (!isNumber(x.at) || !isPingId(x.intent) || !(x.words === null || isString(x.words))) return null;
  if (!isString(x.line) || !isString(x.markdown) || !isString(x.thumb)) return null;
  // Entries written before actions existed have no `done`.
  if (x.done !== undefined && !(Array.isArray(x.done) && x.done.every(isString))) return null;
  const e: Entry = {
    at: x.at, intent: x.intent, words: x.words, line: x.line, markdown: x.markdown, thumb: x.thumb,
    spots: spotCount(x.spots),
  };
  return Array.isArray(x.done) ? { ...e, done: x.done as string[] } : e;
}

/** Threads written before agents have none; a malformed one is dropped, as the session can't be resumed. */
function parseAgent(raw: unknown): AgentSession | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const a = raw as Record<string, unknown>;
  if (!isString(a.profileId) || a.profileId === '' || a.profileId.length > 64) return null;
  if (!isSessionId(a.session) || !isString(a.cwd) || a.cwd === '' || a.cwd.length > 1024) return null;
  return { profileId: a.profileId, session: a.session, cwd: a.cwd };
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
    const agent = parseAgent(r.agent);
    return {
      id: r.id,
      title: r.title,
      started: r.started,
      lastActivity: r.lastActivity,
      app: r.app,
      windowTitle: r.windowTitle,
      profile: r.profile,
      ...(agent ? { agent } : {}),
      entries,
    };
  } catch {
    return null;
  }
}

interface IndexRow extends ThreadSummary {
  /** Lower-cased title, lines and words, so a search never touches the files. */
  searchText: string;
}

const rowOf = (t: ThreadRecord): IndexRow => ({
  id: t.id,
  title: t.title,
  lastActivity: t.lastActivity,
  app: t.app,
  intents: t.entries.map((e) => e.intent),
  ...(t.agent ? { agent: t.agent.profileId } : {}),
  searchText: [t.title, ...t.entries.flatMap((e) => [e.line, e.words ?? ''])].join(' ').toLowerCase(),
});

/**
 * Threads kept on disk, one file each, encrypted through the system keychain.
 * An in-memory index built once at start serves list, search and prune, so asking never decrypts every thread.
 */
export class HistoryStore {
  private currentId: string | null = null;
  private currentRecord: ThreadRecord | null = null;
  private readonly index = new Map<string, IndexRow>();
  private queue: Promise<unknown>;

  constructor(
    private readonly dir: string,
    private readonly crypto: Crypto,
    private readonly now: () => number,
    private readonly options: HistoryOptions = {},
  ) {
    // Jobs run one at a time; the first builds the index and prunes, and nothing else starts before it.
    this.queue = this.available()
      ? this.enqueue(async () => {
          await this.load();
          await this.pruneNow(this.rule(), null);
        }).catch(() => undefined)
      : Promise.resolve();
  }

  available(): boolean {
    return this.crypto.isEncryptionAvailable();
  }

  current(): ThreadRecord | null {
    return this.currentRecord !== null && this.currentRecord.id === this.currentId ? this.currentRecord : null;
  }

  /** Resolves once the thread is loaded (or cleared), so current() is right after the await. */
  async setCurrent(id: string | null): Promise<void> {
    this.currentId = id !== null && ID_RE.test(id) ? id : null;
    this.currentRecord = null;
    const wanted = this.currentId;
    if (wanted === null) return;
    await this.enqueue(async () => {
      const t = await this.read(wanted);
      if (this.currentId === wanted) this.currentRecord = t;
    });
  }

  /** `meta.agent`, the agent session of this answer, replaces the thread's. */
  append(
    threadId: string | null,
    entry: Entry,
    meta: { title: string; app: string; windowTitle: string; profile: string; agent?: AgentSession },
  ): Promise<ThreadRecord> {
    // Read, build and write in one queued job so overlapping appends to a thread can't drop each other's entry.
    return this.enqueue(async () => {
      const writable = this.writable();
      const existing = writable && threadId !== null ? await this.read(threadId) : null;
      const at = this.now();
      const record: ThreadRecord = existing
        ? {
            ...existing, lastActivity: at, entries: [...existing.entries, entry],
            ...(meta.agent ? { agent: meta.agent } : {}),
          }
        : { id: randomUUID(), ...meta, started: at, lastActivity: at, entries: [entry] };
      if (!writable) return record;
      await this.write(record);
      this.index.set(record.id, rowOf(record));
      this.currentId = record.id;
      this.currentRecord = record;
      // The thread just written is never pruned by its own append.
      await this.pruneNow(this.rule(), record.id);
      return record;
    });
  }

  /** Sets what was done for the entry made at `at`: actions that finished after it was written (after consent). */
  async amend(threadId: string, at: number, done: string[]): Promise<void> {
    await this.enqueue(async () => {
      if (!this.writable()) return;
      const t = await this.read(threadId);
      const i = t ? t.entries.findLastIndex((e) => e.at === at) : -1;
      if (!t || i < 0) return;
      const record = { ...t, entries: t.entries.map((e, j) => (j === i ? { ...e, done } : e)) };
      await this.write(record);
      if (this.currentId === record.id) this.currentRecord = record;
    });
  }

  async list(query?: string): Promise<ThreadSummary[]> {
    await this.enqueue(async () => undefined);
    const q = query?.trim().toLowerCase() ?? '';
    return [...this.index.values()]
      .filter((r) => !q || r.searchText.includes(q))
      .map(({ searchText: _text, ...summary }) => summary)
      .sort((a, b) => b.lastActivity - a.lastActivity);
  }

  get(id: string): Promise<ThreadRecord | null> {
    return this.enqueue(() => this.read(id));
  }

  async delete(id: string): Promise<void> {
    if (!ID_RE.test(id)) return;
    await this.enqueue(async () => {
      await rm(this.path(id), { force: true });
      this.forget(id);
    });
  }

  async clear(): Promise<void> {
    await this.enqueue(async () => {
      for (const id of await this.ids()) await rm(this.path(id), { force: true });
      for (const id of [...this.index.keys()]) this.forget(id);
      this.currentId = null;
      this.currentRecord = null;
    });
  }

  async prune(rule: PruneRule): Promise<void> {
    await this.enqueue(() => this.pruneNow(rule, null));
  }

  private forget(id: string): void {
    this.index.delete(id);
    if (this.currentId === id) {
      this.currentId = null;
      this.currentRecord = null;
    }
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

  /** Reads and decrypts one thread; a missing, undecryptable or malformed file is simply absent. */
  private async read(id: string): Promise<ThreadRecord | null> {
    if (!this.available() || !ID_RE.test(id)) return null;
    try {
      const t = parseThread(this.crypto.decryptString(await readFile(this.path(id))));
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

  /** Builds the index once; a file that won't decrypt or parse is skipped, not deleted. */
  private async load(): Promise<void> {
    for (const id of await this.ids()) {
      const t = await this.read(id);
      if (t) this.index.set(id, rowOf(t));
    }
  }

  private async pruneNow(rule: PruneRule, keep: string | null): Promise<void> {
    const doomed = prune([...this.index.values()], this.now(), rule).filter((id) => id !== keep);
    for (const id of doomed) {
      await rm(this.path(id), { force: true });
      this.forget(id);
    }
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
    const run = (this.queue ?? Promise.resolve()).then(job);
    this.queue = run.catch(() => undefined);
    return run;
  }
}

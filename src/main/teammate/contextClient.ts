import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { Point } from '../../shared/ipc';
import type { Shot } from '../../shared/teammate/coords';
import {
  captureCommand, fileOfCommand, marksCommand, parseContextLine, serializeContextCommand, systemTextCommand,
  type ContextCommand, type ContextErrorCode, type ContextReply, type FileHow, type SystemTextLayer,
} from '../../shared/teammate/contextProtocol';

/** `timeout`: no reply in time (the helper was restarted); `exited`: it died or never started; `stopped`: stop() ran. */
export type ContextFailure = ContextErrorCode | 'timeout' | 'aborted' | 'exited' | 'stopped';

export class ContextError extends Error {
  constructor(readonly code: ContextFailure, message: string) {
    super(message);
    this.name = 'ContextError';
  }
}

/** The one `spawn` signature this client uses, so tests can start a fake helper. */
export type SpawnFn = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;

export interface ContextClientOptions {
  command: string;
  spawn?: SpawnFn;
  /** A request without a reply in this time restarts the helper (spec §6.2). */
  timeoutMs?: number;
}

export interface Capture {
  /** The helper keeps this capture's grab under this id, for `marks`. */
  captureId: string;
  overviewPath: string;
  overview: Shot['overview'];
  zooms: { path: string; rect: Shot['zooms'][number] }[];
}

interface Pending {
  expect: ContextReply['type'];
  resolve: (r: ContextReply) => void;
  reject: (e: ContextError) => void;
}

/**
 * Runs context-helper, started on the first request, and matches its replies to requests by id.
 * A request that gets no reply in `timeoutMs` rejects with `timeout` and the helper is restarted.
 */
export class ContextClient {
  private child: ChildProcess | null = null;
  private readonly pending = new Map<string, Pending>();
  private nextId = 1;
  private readonly timeoutMs: number;

  constructor(private readonly opts: ContextClientOptions) {
    this.timeoutMs = opts.timeoutMs ?? 3000;
  }

  async capture(
    req: { display: Shot['display']; spots: { x: number; y: number }[]; dir: string },
    signal: AbortSignal,
  ): Promise<Capture> {
    const r = await this.request((id) => captureCommand(id, req), 'captured', signal);
    if (r.type !== 'captured') throw new ContextError('bad', `unexpected reply ${r.type}`);
    return { captureId: r.id, overviewPath: r.overview, overview: { w: r.ow, h: r.oh }, zooms: r.zooms };
  }

  /** Text and controls near the spots, read from capture `of`'s grab into a marks file in `dir`. */
  async marks(
    req: { of: string; spots: Point[]; radius: number; ocr: boolean; controls: boolean; dir: string },
    signal: AbortSignal,
  ): Promise<{ path: string; count: number }> {
    const r = await this.request((id) => marksCommand(id, req), 'marks', signal);
    if (r.type !== 'marks') throw new ContextError('bad', `unexpected reply ${r.type}`);
    return { path: r.path, count: r.count };
  }

  async systemText(spots: Point[], signal: AbortSignal): Promise<SystemTextLayer> {
    const r = await this.request((id) => systemTextCommand(id, spots), 'systemText', signal);
    if (r.type !== 'systemText') throw new ContextError('bad', `unexpected reply ${r.type}`);
    return r.layer;
  }

  async fileOf(signal: AbortSignal): Promise<{ path: string; address: string; how: FileHow }> {
    const r = await this.request((id) => fileOfCommand(id), 'fileOf', signal);
    if (r.type !== 'fileOf') throw new ContextError('bad', `unexpected reply ${r.type}`);
    return { path: r.path, address: r.address, how: r.how };
  }

  async foreground(signal: AbortSignal): Promise<{ app: string; title: string }> {
    const r = await this.request((id) => ({ type: 'foreground', id }), 'foreground', signal);
    if (r.type !== 'foreground') throw new ContextError('bad', `unexpected reply ${r.type}`);
    return { app: r.app, title: r.title };
  }

  /** Always settles: on the child's exit or error, or after a 1 s fallback that kills it. */
  stop(): Promise<void> {
    this.failAll('stopped', 'the context helper was stopped');
    const child = this.child;
    this.child = null;
    if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(fallback);
        resolve();
      };
      child.once('exit', done);
      child.once('error', done); // a child that failed to spawn never exits
      const fallback = setTimeout(() => {
        child.kill();
        done();
      }, 1000);
      this.write(child, { type: 'shutdown' });
      child.stdin?.end();
    });
  }

  private request(
    make: (id: string) => ContextCommand,
    expect: ContextReply['type'],
    signal: AbortSignal,
  ): Promise<ContextReply> {
    if (signal.aborted) return Promise.reject(new ContextError('aborted', 'the ask was cancelled'));
    const child = this.child ?? this.start();
    const id = `r${this.nextId}`;
    this.nextId += 1;
    return new Promise<ContextReply>((resolve, reject) => {
      const settle = () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        this.pending.delete(id);
      };
      const onAbort = () => {
        settle();
        reject(new ContextError('aborted', 'the ask was cancelled'));
      };
      const timer = setTimeout(() => {
        settle();
        reject(new ContextError('timeout', `no reply from the context helper in ${this.timeoutMs} ms`));
        this.restart();
      }, this.timeoutMs);
      signal.addEventListener('abort', onAbort, { once: true });
      this.pending.set(id, {
        expect,
        resolve: (r) => {
          settle();
          resolve(r);
        },
        reject: (e) => {
          settle();
          reject(e);
        },
      });
      this.write(child, make(id));
    });
  }

  private start(): ChildProcess {
    const run = this.opts.spawn ?? spawn;
    const child = run(this.opts.command, [], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    this.child = child;
    let gone = false;
    const onGone = (reason: string) => {
      if (gone) return;
      gone = true;
      if (this.child !== child) return; // a replaced helper: its requests were already failed
      this.child = null;
      this.failAll('exited', `the context helper stopped: ${reason}`);
    };
    child.on('error', (err) => onGone(err.message));
    child.on('exit', (code) => onGone(`exit code ${code}`));
    child.stdin?.on('error', () => undefined); // EPIPE after a crash; 'exit' handles it
    if (child.stdout) createInterface({ input: child.stdout }).on('line', (line) => this.onLine(child, line));
    return child;
  }

  /** A stuck helper is killed and a fresh one started, so the next ask finds it ready. */
  private restart(): void {
    const old = this.child;
    this.child = null;
    this.failAll('timeout', 'the context helper was restarted');
    old?.kill();
    this.start();
  }

  private onLine(child: ChildProcess, line: string): void {
    if (child !== this.child) return;
    const reply = parseContextLine(line);
    if (!reply) return;
    const p = this.pending.get(reply.id); // none when aborted or timed out already
    if (p) {
      if (reply.type === 'error') p.reject(new ContextError(reply.code, reply.message));
      else if (reply.type !== p.expect) p.reject(new ContextError('bad', `expected ${p.expect}, got ${reply.type}`));
      else p.resolve(reply);
    }
    if (reply.type === 'error' && reply.code === 'slow') {
      // The helper exits after this reply and reads nothing more: the next request must start a fresh one.
      this.child = null;
      this.failAll('exited', 'the context helper stopped after a slow probe');
      child.kill();
    }
  }

  private failAll(code: ContextFailure, message: string): void {
    for (const p of [...this.pending.values()]) p.reject(new ContextError(code, message));
  }

  private write(child: ChildProcess, cmd: ContextCommand): void {
    const stdin = child.stdin;
    if (stdin && !stdin.destroyed && stdin.writable) stdin.write(serializeContextCommand(cmd));
  }
}

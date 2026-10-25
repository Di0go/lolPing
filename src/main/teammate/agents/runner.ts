import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { platformOf, type Platform } from '../../../shared/platform';
import { AGENT_PRESETS, type AgentParsed, type AgentRunSpec } from '../../../shared/teammate/agents';
import type { AgentProfile } from '../../../shared/teammate/settings';
import { findExecutable, spawnArgv, system32 } from './command';

const TAIL_MAX = 8 * 1024;
const LINE_MAX = 1024 * 1024;
const KILL_GRACE_MS = 2000;
// Presets name a failure 'error' when the agent gave no text; a stderr line says more.
const BARE_ERROR = 'error';

export interface AgentResult {
  code: number | null;
  /** The last session id the agent printed. */
  session: string | null;
  /** The parsed error, else stderr's first line, so it can be set on a run that worked: judge success by `code`. */
  error: string | null;
  /** The last 8 KB of stdout and of stderr, joined by a line break. */
  tail: string;
}

export interface AgentRun {
  readonly done: Promise<AgentResult>;
  /** The last session id the agent has printed so far: an answer kept before the agent exits keeps it too. */
  session(): string | null;
  kill(): void;
}

export class AgentStartError extends Error {
  constructor(readonly kind: 'notFound' | 'noFolder' | 'spawn', message: string) {
    super(message);
    this.name = 'AgentStartError';
  }
}

export interface AgentRunnerDeps {
  spawn: typeof nodeSpawn;
  platform: Platform;
  killTree: (pid: number) => void;
  writeFile: (p: string, text: string) => Promise<void>;
}

// What the agent itself gets of the bridge's environment; the rest belongs to the bridge process alone.
const AGENT_BRIDGE_ENV = ['LOLPING_PIPE', 'LOLPING_DATA', 'LOLPING_ASK'];

function agentBridgeEnv(env: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter(([k]) => AGENT_BRIDGE_ENV.includes(k)));
}

const TOKEN = /\{(prompt|askDir|mcpConfig)\}/g;

/** A custom profile's lines with the placeholders filled; each line stays one argument. */
function customArgv(lines: readonly string[], s: AgentRunSpec): string[] {
  const value = (key: string): string => (key === 'prompt' ? s.prompt : key === 'askDir' ? s.askDir : s.mcpConfigPath);
  return lines.map((line) => line.replace(TOKEN, (_m, key: string) => value(key)));
}

/** A variable by name; Windows names ignore case, and a copied env keeps whatever case the system used. */
export function envValue(env: NodeJS.ProcessEnv, name: string, platform: Platform): string | undefined {
  if (env[name] !== undefined || platform !== 'win') return env[name];
  const key = Object.keys(env).find((k) => k.toUpperCase() === name);
  return key === undefined ? undefined : env[key];
}

/** PATH and PATHEXT of `env`, as findExecutable reads them. */
export function searchPath(env: NodeJS.ProcessEnv, platform: Platform): { PATH: string; PATHEXT?: string } {
  return { PATH: envValue(env, 'PATH', platform) ?? '', PATHEXT: envValue(env, 'PATHEXT', platform) };
}

/** A file that can be run: on macOS and Linux it needs the execute bit, so a script or README on PATH isn't taken. */
export function isExecutable(p: string): boolean {
  try {
    if (!statSync(p).isFile()) return false;
    if (platformOf(process.platform) !== 'win') accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** A folder that is there: a missing working folder would fail the spawn as if the command were broken. */
function isFolder(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

const keepTail = (tail: string, chunk: string): string => (tail.length + chunk.length <= TAIL_MAX
  ? tail + chunk : (tail + chunk).slice(-TAIL_MAX));

/** Calls `onLine` for each line of a stream; a line longer than LINE_MAX is dropped whole. */
function lineReader(onLine: (line: string) => void): { push(chunk: string): void; end(): void } {
  let partial = '';
  let skipping = false;
  return {
    push(chunk) {
      const parts = chunk.split('\n');
      const last = parts.pop() ?? '';
      for (const part of parts) {
        if (!skipping && partial.length + part.length <= LINE_MAX) onLine((partial + part).replace(/\r$/, ''));
        partial = '';
        skipping = false;
      }
      if (skipping) return;
      partial += last;
      if (partial.length > LINE_MAX) {
        partial = '';
        skipping = true;
      }
    },
    end() {
      if (!skipping && partial !== '') onLine(partial.replace(/\r$/, ''));
      partial = '';
    },
  };
}

// Node's own warnings ("(node:123) DeprecationWarning: …" and the "(Use `node --trace-…`" line under it) say
// nothing about why the agent failed.
const NODE_WARNING = /^\(node:\d+\)|^\(Use `node --trace-/;

/** stderr's first line that isn't empty or one of Node's warnings. */
const firstLine = (text: string): string | null => text.split('\n').map((l) => l.trim())
  .find((l) => l !== '' && !NODE_WARNING.test(l)) ?? null;

/** Starts coding agents headless, reads their output, and stops them with everything they started. */
export class AgentRunner {
  private readonly live = new Set<AgentRun>();

  constructor(private readonly deps: AgentRunnerDeps) {}

  async start(p: AgentProfile, spec: AgentRunSpec, cwd: string, env: NodeJS.ProcessEnv): Promise<AgentRun> {
    const { platform } = this.deps;
    const preset = p.preset === 'custom' ? null : AGENT_PRESETS[p.preset];
    if (!isFolder(cwd)) throw new AgentStartError('noFolder', `${cwd} is not a folder`);
    const file = findExecutable(p.command, searchPath(env, platform), platform, isExecutable);
    if (file === null) throw new AgentStartError('notFound', `Couldn't find ${p.command}`);

    // A custom command gets Claude's mcpServers file, the shape most agents read.
    const config = preset === null ? AGENT_PRESETS.claude.configFile(spec) : preset.configFile(spec);
    if (config !== null) await this.deps.writeFile(spec.mcpConfigPath, config);

    const args = preset === null ? customArgv(p.customArgs, spec) : preset.args(spec);
    const childEnv: NodeJS.ProcessEnv = {
      ...env, ...preset?.env(spec), ...agentBridgeEnv(spec.bridge.env), LOLPING_ASK_DIR: spec.askDir,
    };
    // lolPing's own node switch would make any Electron app the agent starts run as plain Node.
    delete childEnv.ELECTRON_RUN_AS_NODE;
    let child: ChildProcess;
    try {
      const argv = spawnArgv(file, args, platform);
      child = this.deps.spawn(argv.file, argv.args, {
        cwd, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
        // Its own process group on macOS and Linux, so killTree can signal everything it started.
        detached: platform !== 'win', windowsVerbatimArguments: argv.verbatim,
      });
    } catch (e) {
      throw new AgentStartError('spawn', e instanceof Error ? e.message : String(e));
    }
    const run = this.watch(child, preset === null ? () => ({}) : (line) => preset.parse(line));
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', (e) => reject(new AgentStartError('spawn', e.message)));
    });
    this.live.add(run);
    return run;
  }

  killAll(): void {
    for (const run of this.live) {
      try {
        run.kill();
      } catch {
        // One run that can't be signalled must not leave the others running.
      }
    }
  }

  private watch(child: ChildProcess, parse: (line: string) => AgentParsed): AgentRun {
    let session: string | null = null;
    let parsedError: string | null = null;
    let bareError = false;
    let stdoutTail = '';
    let stderrTail = '';
    let stderrHead = '';
    let over = false;
    let killed = false;

    const lines = lineReader((line) => {
      const r = parse(line);
      if (r.session !== undefined) session = r.session;
      if (r.error === BARE_ERROR) bareError = true;
      else if (r.error !== undefined) parsedError = r.error;
    });
    child.stdout?.setEncoding('utf8').on('data', (chunk: string) => {
      stdoutTail = keepTail(stdoutTail, chunk);
      lines.push(chunk);
    });
    child.stderr?.setEncoding('utf8').on('data', (chunk: string) => {
      stderrTail = keepTail(stderrTail, chunk);
      if (stderrHead.length < TAIL_MAX) stderrHead += chunk.slice(0, TAIL_MAX - stderrHead.length);
    });
    // After 'spawn', an error is a failed kill or a broken pipe; 'close' still ends the run.
    child.on('error', () => undefined);

    const run: AgentRun = {
      done: new Promise((resolve) => {
        child.once('close', (code: number | null) => {
          over = true;
          this.live.delete(run);
          lines.end();
          resolve({
            code, session,
            error: parsedError ?? firstLine(stderrHead) ?? (bareError ? BARE_ERROR : null),
            tail: [stdoutTail, stderrTail].join('\n'),
          });
        });
      }),
      session: () => session,
      kill: () => {
        if (over || killed || child.pid === undefined) return;
        killed = true;
        this.deps.killTree(child.pid);
      },
    };
    return run;
  }
}

/** Ends a process and everything it started: taskkill /t on Windows, the process group elsewhere. */
export function killProcessTree(platform: Platform): (pid: number) => void {
  if (platform === 'win') {
    return (pid) => {
      nodeSpawn(system32('taskkill.exe'), ['/pid', String(pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' })
        .on('error', () => undefined);
    };
  }
  const signal = (pid: number, s: NodeJS.Signals | 0): boolean => {
    try {
      process.kill(-pid, s);
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ESRCH') return false;
      throw e;
    }
  };
  return (pid) => {
    try {
      if (!signal(pid, 'SIGTERM')) return;
    } catch {
      return; // EPERM: the group isn't ours to signal, and there is nothing else to try
    }
    setTimeout(() => {
      try {
        if (signal(pid, 0)) signal(pid, 'SIGKILL');
      } catch {
        // Nothing left to do from a timer.
      }
    }, KILL_GRACE_MS).unref();
  };
}

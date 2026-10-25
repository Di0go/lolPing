import type { spawn as nodeSpawn } from 'node:child_process';
import type { CheckAgentResult } from '../../../shared/ipc';
import type { Platform } from '../../../shared/platform';
import type { AgentProfile } from '../../../shared/teammate/settings';
import { spawnArgv } from './command';

/** How long `--version` may take before the check gives up. */
export const CHECK_MS = 5000;
const VERSION_MAX = 80;
const OUTPUT_MAX = 8 * 1024;

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface CheckAgentDeps {
  /** The executable for a command on the user's PATH, or null. */
  find(command: string): string | null;
  /** Runs a file and gives what it printed; rejects when it can't be started. */
  run(file: string, args: string[], ms: number): Promise<RunResult>;
}

const firstLine = (text: string): string => text.split('\n').map((l) => l.trim()).find((l) => l !== '') ?? '';

/** Runs `<command> --version` and says what it printed. It never starts an ask, so it costs no tokens. */
export async function checkAgent(p: AgentProfile, deps: CheckAgentDeps): Promise<CheckAgentResult> {
  const command = p.command.trim();
  const file = command === '' ? null : deps.find(command);
  if (file === null) return { ok: false, reason: 'notFound', detail: command };
  let r: RunResult;
  try {
    r = await deps.run(file, ['--version'], CHECK_MS);
  } catch (e) {
    return { ok: false, reason: 'failed', detail: firstLine(e instanceof Error ? e.message : String(e)) };
  }
  if (r.timedOut) return { ok: false, reason: 'timeout', detail: '' };
  if (r.code !== 0) return { ok: false, reason: 'failed', detail: firstLine(r.stderr) };
  return { ok: true, version: [...(firstLine(r.stdout) || firstLine(r.stderr))].slice(0, VERSION_MAX).join('') };
}

/** `run` for checkAgent: the same route the runner takes (so a .cmd shim works), with stdin closed and a time limit. */
export function captureOutput(d: {
  spawn: typeof nodeSpawn; platform: Platform; killTree: (pid: number) => void; env: () => NodeJS.ProcessEnv;
}): CheckAgentDeps['run'] {
  return (file, args, ms) => new Promise<RunResult>((resolve, reject) => {
    const argv = spawnArgv(file, args, d.platform);
    const child = d.spawn(argv.file, argv.args, {
      env: d.env(), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
      // Its own process group on macOS and Linux, so killTree can signal everything it started.
      detached: d.platform !== 'win', windowsVerbatimArguments: argv.verbatim,
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (r: RunResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    const timer = setTimeout(() => {
      if (child.pid !== undefined) d.killTree(child.pid);
      finish({ code: null, stdout, stderr, timedOut: true });
    }, ms);
    child.stdout?.setEncoding('utf8').on('data', (c: string) => {
      stdout = (stdout + c).slice(0, OUTPUT_MAX);
    });
    child.stderr?.setEncoding('utf8').on('data', (c: string) => {
      stderr = (stderr + c).slice(0, OUTPUT_MAX);
    });
    child.once('error', (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(e);
    });
    child.once('close', (code) => finish({ code, stdout, stderr, timedOut: false }));
  });
}

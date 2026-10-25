import { spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { captureOutput, CHECK_MS, checkAgent, type RunResult } from '../../../../src/main/teammate/agents/check';
import { findExecutable } from '../../../../src/main/teammate/agents/command';
import { killProcessTree } from '../../../../src/main/teammate/agents/runner';
import { platformOf } from '../../../../src/shared/platform';
import type { AgentProfile } from '../../../../src/shared/teammate/settings';

const platform = platformOf(process.platform);
const win = process.platform === 'win32';

function profile(over: Partial<AgentProfile> = {}): AgentProfile {
  return {
    id: 'a1', kind: 'agent', name: 'Claude Code', tagColor: 0, tagColorCustom: null, preset: 'claude', command: 'claude',
    customArgs: [], folder: { kind: 'editor', folders: [] }, timeoutS: 300, ...over,
  };
}

const ran = (over: Partial<RunResult> = {}): RunResult => ({ code: 0, stdout: '', stderr: '', timedOut: false, ...over });

describe('checkAgent', () => {
  it('reports the version an agent prints', async () => {
    const calls: Array<{ file: string; args: string[]; ms: number }> = [];
    const r = await checkAgent(profile(), {
      find: (command) => (command === 'claude' ? '/bin/claude' : null),
      run: async (file, args, ms) => {
        calls.push({ file, args, ms });
        return ran({ stdout: '\n2.1.7 (Claude Code)\nmore\n' });
      },
    });
    expect(r).toEqual({ ok: true, version: '2.1.7 (Claude Code)' });
    expect(calls).toEqual([{ file: '/bin/claude', args: ['--version'], ms: CHECK_MS }]);
    expect(CHECK_MS).toBe(5000);
  });

  it('takes the version from stderr when stdout is empty, and cuts a long line to 80 characters', async () => {
    const r = await checkAgent(profile(), { find: () => 'x', run: async () => ran({ stderr: `${'v'.repeat(200)}\n` }) });
    expect(r).toEqual({ ok: true, version: 'v'.repeat(80) });
  });

  it('reports a command that is not on PATH, without running anything', async () => {
    let started = false;
    const deps = {
      find: () => null,
      run: async () => {
        started = true;
        return ran();
      },
    };
    expect(await checkAgent(profile({ command: 'codex' }), deps)).toEqual({ ok: false, reason: 'notFound', detail: 'codex' });
    expect(await checkAgent(profile({ command: '   ' }), deps)).toMatchObject({ ok: false, reason: 'notFound' });
    expect(started).toBe(false);
  });

  it('gives up on a command that hangs after 5 s', async () => {
    let limit = 0;
    const r = await checkAgent(profile(), {
      find: () => 'x',
      run: async (_file, _args, ms) => {
        limit = ms;
        return ran({ code: null, timedOut: true });
      },
    });
    expect(limit).toBe(5000);
    expect(r).toEqual({ ok: false, reason: 'timeout', detail: '' });
  });

  it('reports a non-zero exit with the first line of stderr', async () => {
    const r = await checkAgent(profile(), {
      find: () => 'x', run: async () => ran({ code: 2, stdout: '1.0', stderr: '\n  bad flag  \nmore' }),
    });
    expect(r).toEqual({ ok: false, reason: 'failed', detail: 'bad flag' });
  });

  it('reports a command that could not be started', async () => {
    const r = await checkAgent(profile(), {
      find: () => 'x',
      run: async () => {
        throw new Error('spawn EACCES\nstack');
      },
    });
    expect(r).toEqual({ ok: false, reason: 'failed', detail: 'spawn EACCES' });
  });
});

describe('captureOutput', () => {
  let dir = '';
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = '';
  });
  const run = captureOutput({ spawn, platform, killTree: killProcessTree(platform), env: () => process.env });

  it('collects what a command prints and its exit code', async () => {
    const r = await run(process.execPath, ['-e', 'console.log("hi"); console.error("oops"); process.exitCode = 3'], 10_000);
    expect(r).toEqual({ code: 3, stdout: 'hi\n', stderr: 'oops\n', timedOut: false });
  });

  it('stops a command that outlives the limit', async () => {
    const r = await run(process.execPath, ['-e', 'setInterval(() => undefined, 1000)'], 300);
    expect(r.timedOut).toBe(true);
  });

  it.skipIf(!win)('runs a .cmd shim found on PATH the way the runner does', async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'lolping check '));
    await writeFile(path.join(dir, 'fakeagent.cmd'), '@echo off\r\necho 9.9.9 (Fake) %1\r\n');
    const exists = (p: string): boolean => {
      try {
        return statSync(p).isFile();
      } catch {
        return false;
      }
    };
    const r = await checkAgent(profile({ command: 'fakeagent' }), {
      find: (c) => findExecutable(c, { PATH: dir }, platform, exists), run,
    });
    // The shim echoes its argument as the C runtime quoted it; the version line is what counts.
    expect(r).toMatchObject({ ok: true, version: expect.stringMatching(/^9\.9\.9 \(Fake\) "?--version"?$/) });
  });
});

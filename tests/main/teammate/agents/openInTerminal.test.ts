import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { system32 } from '../../../../src/main/teammate/agents/command';
import { launchTerminal, terminalArgv, type LaunchSpawn } from '../../../../src/main/teammate/agents/openInTerminal';

describe('terminalArgv on Windows', () => {
  it('opens cmd in the folder with the resume command quoted', () => {
    const argv = terminalArgv('win', 'C:\\my proj\\a&b', 'C:\\tools\\claude.exe', ['--resume', 's 1&2']);
    expect(argv.verbatim).toBe(true);
    expect(argv.file).toBe(system32('cmd.exe'));
    const cmd = system32('cmd.exe').replace(/([ ()&^])/g, '^$1');
    expect(argv.args).toEqual([
      '/d', '/v:off', '/c', 'start', '""', '/d', '^"C:\\my^ proj\\a^&b^"', `^"${cmd}^"`,
      '/d', '/v:off', '/s', '/k',
      '^"^^^"C:\\tools\\claude.exe^^^"^ ^^^"--resume^^^"^ ^^^"s^^^ 1^^^&2^^^"^"',
    ]);
  });

  it('refuses a line break, which would end the command line there', () => {
    expect(() => terminalArgv('win', 'C:\\x', 'C:\\tools\\claude.exe', ['a\nb'])).toThrow();
  });

  describe('through the real cmd.exe', () => {
    let dir = '';
    afterEach(async () => {
      if (dir !== '') await rm(dir, { recursive: true, force: true });
      dir = '';
    });

    /** Runs the command line terminalArgv builds, without the new window: `cd` stands in for `start /d`. */
    function runThrough(argv: ReturnType<typeof terminalArgv>): Promise<{ argv: string[]; cwd: string }> {
      const at = argv.args.indexOf('start');
      // After `start "" /d` come the folder, cmd.exe, its switches and the line; /k would keep the window open.
      const [folder, ...rest] = argv.args.slice(at + 3);
      const inner = rest.map((a) => (a === '/k' ? '/c' : a));
      const outer = ['/d', '/c', 'cd', '/d', folder, '&&', ...inner];
      return new Promise((resolve, reject) => {
        const child = spawn(argv.file, outer, { stdio: ['ignore', 'pipe', 'pipe'], windowsVerbatimArguments: true });
        let out = '';
        let err = '';
        child.stdout.setEncoding('utf8').on('data', (c: string) => { out += c; });
        child.stderr.setEncoding('utf8').on('data', (c: string) => { err += c; });
        child.on('error', reject);
        child.on('close', (code) => {
          if (code !== 0) reject(new Error(`exit ${String(code)}: ${err}`));
          else resolve(JSON.parse(out) as { argv: string[]; cwd: string });
        });
      });
    }

    // The names need quoting twice over: a space, &, ( ) and % are all special to cmd.exe.
    const setup = async (): Promise<{ cwd: string; script: string }> => {
      dir = await mkdtemp(path.join(os.tmpdir(), 'lolping term (1) & x '));
      const cwd = path.join(dir, 'my proj & (co)');
      await mkdir(cwd);
      const script = path.join(dir, 'echo.cjs');
      await writeFile(script, 'process.stdout.write(JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }));\n');
      return { cwd, script };
    };

    it.runIf(process.platform === 'win32')('keeps a folder and a session id with spaces and & intact', async () => {
      const { cwd, script } = await setup();
      const args = ['--resume', 'sess 1 & echo INJECTED', 'a"b', '50%', '%PATH%', 'x|y<z>w', '^', 'C:\\dir\\'];
      const got = await runThrough(terminalArgv('win', cwd, process.execPath, [script, ...args]));
      expect(got.argv).toEqual(args);
      expect(got.cwd.toLowerCase()).toBe(cwd.toLowerCase());
    });

    it.runIf(process.platform === 'win32')('runs a .cmd shim with the same arguments', async () => {
      const { cwd, script } = await setup();
      const shim = path.join(dir, 'fake agent.cmd');
      await writeFile(shim, `@"${process.execPath}" "${script}" %*\r\n`);
      const args = ['--resume', 'sess 1 & echo INJECTED', 'a"b', '%PATH%', 'C:\\dir\\'];
      const got = await runThrough(terminalArgv('win', cwd, shim, args));
      expect(got.argv).toEqual(args);
      expect(got.cwd.toLowerCase()).toBe(cwd.toLowerCase());
    });
  });
});

describe('terminalArgv on macOS', () => {
  it('tells Terminal to run cd and the command with every word in single quotes', () => {
    const argv = terminalArgv('mac', '/Users/me/my proj', '/opt/bin/claude', ['--resume', 'abc']);
    expect(argv).toEqual({
      file: 'osascript', verbatim: false,
      args: [
        '-e', 'tell application "Terminal" to do script "cd \'/Users/me/my proj\' && \'/opt/bin/claude\' \'--resume\' \'abc\'"',
        '-e', 'tell application "Terminal" to activate',
      ],
    });
  });

  it('escapes single quotes in the macOS Terminal script', () => {
    const argv = terminalArgv('mac', '/Users/o\'neil/proj', '/opt/bin/claude', ['--resume', 'it\'s']);
    // POSIX: ' becomes '\'' ; AppleScript then needs each \ doubled.
    expect(argv.args[1]).toBe(
      'tell application "Terminal" to do script "cd \'/Users/o\'\\\\\'\'neil/proj\' && \'/opt/bin/claude\' \'--resume\' \'it\'\\\\\'\'s\'"',
    );
  });

  it('escapes double quotes and backslashes for AppleScript', () => {
    const argv = terminalArgv('mac', '/a"b\\c', '/x', []);
    expect(argv.args[1]).toBe('tell application "Terminal" to do script "cd \'/a\\"b\\\\c\' && \'/x\'"');
  });
});

describe('terminalArgv and control characters', () => {
  // Terminal types the line into an interactive shell, where Ctrl-U and the like edit it instead of being quoted text.
  it.each(['mac', 'linux'] as const)('refuses a control character or DEL anywhere on %s', (platform) => {
    for (const bad of ['\u0015', '\u0000', '\u001b', '\u007f', '\n', '\t']) {
      expect(() => terminalArgv(platform, `/a${bad}b`, '/x', [])).toThrow();
      expect(() => terminalArgv(platform, '/a', `/x${bad}`, [])).toThrow();
      expect(() => terminalArgv(platform, '/a', '/x', ['--resume', `s${bad}`])).toThrow();
    }
    expect(() => terminalArgv(platform, '/a b/ü', '/x', ['--resume', 's 1'])).not.toThrow();
  });
});

describe('terminalArgv on Linux', () => {
  it('runs sh -c with the folder and command single-quoted', () => {
    expect(terminalArgv('linux', '/home/me/it\'s', '/usr/bin/claude', ['--resume', 'a b'])).toEqual({
      file: 'x-terminal-emulator', verbatim: false,
      args: ['-e', 'sh', '-c', 'cd \'/home/me/it\'\\\'\'s\' && \'/usr/bin/claude\' \'--resume\' \'a b\''],
    });
  });
});

describe('launchTerminal', () => {
  /** A spawn that records the call and gives a child that `act` then drives. */
  function fake(act: (child: EventEmitter) => void) {
    const calls: Array<{ file: string; args: string[]; verbatim: boolean | undefined }> = [];
    const spawnFn: LaunchSpawn = (file, args, options) => {
      calls.push({ file, args, verbatim: options.windowsVerbatimArguments });
      const child = Object.assign(new EventEmitter(), { unref: () => undefined });
      queueMicrotask(() => act(child));
      return child;
    };
    return { calls, spawnFn };
  }
  const run = (spawnFn: LaunchSpawn, platform: 'win' | 'mac' | 'linux' = 'mac') =>
    launchTerminal({ spawn: spawnFn, platform, cwd: '/a', file: '/x', args: ['--resume', 's'], env: {} });

  it('succeeds when the launcher exits 0, and passes the verbatim flag on', async () => {
    const f = fake((c) => c.emit('exit', 0));
    expect(await run(f.spawnFn, 'win')).toBe(true);
    expect(f.calls[0].file).toBe(system32('cmd.exe'));
    expect(f.calls[0].verbatim).toBe(true);
  });

  it('fails when osascript or start exits with an error', async () => {
    expect(await run(fake((c) => c.emit('exit', 1)).spawnFn)).toBe(false);
    expect(await run(fake((c) => c.emit('exit', null)).spawnFn, 'win')).toBe(false);
  });

  it('fails when the launcher can\'t be started', async () => {
    expect(await run(fake((c) => c.emit('error', new Error('ENOENT'))).spawnFn, 'linux')).toBe(false);
  });

  it('does not wait for a Linux terminal to close', async () => {
    expect(await run(fake((c) => c.emit('spawn')).spawnFn, 'linux')).toBe(true);
  });

  it('fails without starting anything when the line has a control character', async () => {
    const f = fake(() => undefined);
    expect(await launchTerminal({ spawn: f.spawnFn, platform: 'mac', cwd: '/a\u0015b', file: '/x', args: [], env: {} }))
      .toBe(false);
    expect(f.calls).toEqual([]);
  });
});

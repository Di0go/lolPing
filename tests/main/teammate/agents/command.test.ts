import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { findExecutable, spawnArgv } from '../../../../src/main/teammate/agents/command';

const existing = (...files: string[]) => {
  const set = new Set(files.map((f) => f.toLowerCase()));
  return (p: string): boolean => set.has(p.toLowerCase());
};

/** Runs file + args the way the runner does and returns what the child printed. */
function run(file: string, args: readonly string[]): Promise<string> {
  const argv = spawnArgv(file, args, 'win');
  return new Promise((resolve, reject) => {
    const child = spawn(argv.file, argv.args, {
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, windowsVerbatimArguments: argv.verbatim,
    });
    let out = '';
    let err = '';
    child.stdout.setEncoding('utf8').on('data', (c: string) => { out += c; });
    child.stderr.setEncoding('utf8').on('data', (c: string) => { err += c; });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`exit ${String(code)}: ${err}`))));
  });
}

describe('findExecutable', () => {
  const winEnv = { PATH: 'C:\\Windows\\System32;C:\\Users\\x y\\AppData\\Roaming\\npm;C:\\tools', PATHEXT: '.COM;.EXE;.BAT;.CMD' };

  it('finds claude.exe and a codex.cmd shim through PATHEXT', () => {
    const exists = existing('C:\\tools\\claude.exe', 'C:\\Users\\x y\\AppData\\Roaming\\npm\\codex.cmd');
    expect(findExecutable('claude', winEnv, 'win', exists)).toBe('C:\\tools\\claude.exe');
    expect(findExecutable('codex', winEnv, 'win', exists)).toBe('C:\\Users\\x y\\AppData\\Roaming\\npm\\codex.cmd');
  });

  it('skips npm\'s extensionless sh script on Windows and takes the .cmd beside it', () => {
    const npm = 'C:\\Users\\x y\\AppData\\Roaming\\npm';
    const exists = existing(`${npm}\\codex`, `${npm}\\codex.cmd`);
    expect(findExecutable('codex', winEnv, 'win', exists)).toBe(`${npm}\\codex.cmd`);
    expect(findExecutable(`${npm}\\codex`, winEnv, 'win', exists)).toBe(`${npm}\\codex.cmd`);
  });

  it('takes a name that already has an extension as it is', () => {
    expect(findExecutable('dsh.cmd', winEnv, 'win', existing('C:\\tools\\dsh.cmd'))).toBe('C:\\tools\\dsh.cmd');
  });

  it('uses the default PATHEXT when the environment has none', () => {
    expect(findExecutable('gemini', { PATH: 'C:\\tools' }, 'win', existing('C:\\tools\\gemini.cmd')))
      .toBe('C:\\tools\\gemini.cmd');
  });

  it('checks a full path as it is', () => {
    expect(findExecutable('C:\\agents\\my agent.exe', winEnv, 'win', existing('C:\\agents\\my agent.exe')))
      .toBe('C:\\agents\\my agent.exe');
    expect(findExecutable('/opt/agent/bin/claude', { PATH: '/usr/bin' }, 'mac', existing('/opt/agent/bin/claude')))
      .toBe('/opt/agent/bin/claude');
  });

  it('splits PATH by colons on macOS and Linux', () => {
    const env = { PATH: '/usr/bin:/Users/x/.local/bin:/opt/homebrew/bin' };
    const exists = existing('/opt/homebrew/bin/claude', '/opt/homebrew/bin/claude.exe');
    expect(findExecutable('claude', env, 'mac', exists)).toBe('/opt/homebrew/bin/claude');
    expect(findExecutable('claude', env, 'linux', exists)).toBe('/opt/homebrew/bin/claude');
  });

  it('returns null when nothing on PATH matches', () => {
    expect(findExecutable('claude', winEnv, 'win', () => false)).toBeNull();
    expect(findExecutable('claude', { PATH: '/usr/bin' }, 'linux', () => false)).toBeNull();
  });
});

describe('spawnArgv', () => {
  it('passes a real exe\'s arguments untouched', () => {
    const args = ['-p', 'Read ask.md in C:\\x y', '--mcp-config', 'C:\\a&b\\mcp.json'];
    expect(spawnArgv('C:\\tools\\claude.exe', args, 'win')).toEqual({ file: 'C:\\tools\\claude.exe', args, verbatim: false });
    expect(spawnArgv('/usr/bin/claude', args, 'mac')).toEqual({ file: '/usr/bin/claude', args, verbatim: false });
    expect(spawnArgv('/usr/bin/run.cmd', args, 'linux')).toEqual({ file: '/usr/bin/run.cmd', args, verbatim: false });
  });

  it('builds one cmd.exe line with every metacharacter caret-escaped twice', () => {
    const argv = spawnArgv('C:\\x y\\codex.CMD', ['a&b', '50%', 'a"b', 'C:\\dir\\'], 'win');
    expect(argv.file).toBe('cmd.exe');
    expect(argv.verbatim).toBe(true);
    expect(argv.args).toEqual([
      '/d', '/s', '/c',
      '"C:\\x^ y\\codex.CMD ^^^"a^^^&b^^^" ^^^"50^^^%^^^" ^^^"a\\^^^"b^^^" ^^^"C:\\dir\\\\^^^""',
    ]);
  });

  it('refuses a line break in an argument for a .cmd', () => {
    expect(() => spawnArgv('C:\\tools\\dsh.cmd', ['a\nb'], 'win')).toThrow();
    expect(() => spawnArgv('C:\\tools\\dsh.bat', ['a\rb'], 'win')).toThrow();
  });

  describe('through a real .cmd shim', () => {
    let dir = '';
    afterEach(async () => {
      if (dir !== '') await rm(dir, { recursive: true, force: true });
      dir = '';
    });

    it.runIf(process.platform === 'win32')('quotes every argument for cmd.exe so & and spaces stay inside it', async () => {
      // The folder name needs quoting too, like C:\Users\Darren Meng\AppData\Roaming\npm.
      dir = await mkdtemp(path.join(os.tmpdir(), 'lolping shim (1) & '));
      await writeFile(path.join(dir, 'fake.cmd'), '@node "%~dp0echo.cjs" %*\r\n');
      await writeFile(path.join(dir, 'echo.cjs'), 'process.stdout.write(JSON.stringify(process.argv.slice(2)));\n');
      // A lone quote first: cmd's own quote counting then flips, and only the carets keep the & after it inert.
      const args = [
        'a"b', 'C:\\a b&c', '50%', '%PATH%', '!x!', 'a\\\\"b', '^', '(x)', 'C:\\dir\\', 'x|y<z>w', '',
        '-c', 'mcp_servers.lolping.command="C:\\\\x y\\\\node.exe"', 'Read ask.md in C:\\x y, then answer.',
        'then&echo INJECTED',
      ];
      const out = await run(path.join(dir, 'fake.cmd'), args);
      expect(JSON.parse(out)).toEqual(args);
    });
  });
});

describe('userPath', () => {
  afterEach(() => {
    vi.resetModules();
  });

  const fresh = async () => (await import('../../../../src/main/teammate/agents/command')).userPath;

  it('asks the login shell for PATH on macOS once per process', async () => {
    const userPath = await fresh();
    const run = vi.fn(async () => 'Last login: today\n/opt/homebrew/bin:/usr/bin');
    expect(await userPath('mac', run)).toBe('/opt/homebrew/bin:/usr/bin');
    expect(await userPath('mac', run)).toBe('/opt/homebrew/bin:/usr/bin');
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith(process.env.SHELL || '/bin/zsh', ['-ilc', 'printf %s "$PATH"'], 3000);
  });

  it('falls back to its own PATH when the shell fails', async () => {
    const userPath = await fresh();
    expect(await userPath('mac', async () => { throw new Error('timed out'); })).toBe(process.env.PATH ?? '');
  });

  it('uses its own PATH on Windows and Linux without running a shell', async () => {
    const userPath = await fresh();
    const run = vi.fn(async () => '/elsewhere');
    expect(await userPath('win', run)).toBe(process.env.PATH ?? '');
    expect(await userPath('linux', run)).toBe(process.env.PATH ?? '');
    expect(run).not.toHaveBeenCalled();
  });
});

import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { findExecutable, spawnArgv, withPath } from '../../../../src/main/teammate/agents/command';

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

  it('tries a name with an extension before adding PATHEXT to it', () => {
    const exists = existing('C:\\tools\\dsh.cmd', 'C:\\tools\\dsh.cmd.exe', 'C:\\a\\my agent.exe', 'C:\\a\\my agent.exe.cmd');
    expect(findExecutable('dsh.cmd', winEnv, 'win', exists)).toBe('C:\\tools\\dsh.cmd');
    expect(findExecutable('C:\\a\\my agent.exe', winEnv, 'win', exists)).toBe('C:\\a\\my agent.exe');
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
    const argv = spawnArgv('C:\\x y\\codex.CMD', ['a&b', 'a"b', 'C:\\dir\\'], 'win');
    expect(argv.verbatim).toBe(true);
    expect(argv.args).toEqual([
      '/d', '/v:off', '/s', '/c', '"C:\\x^ y\\codex.CMD ^^^"a^^^&b^^^" ^^^"a\\^^^"b^^^" ^^^"C:\\dir\\\\^^^""',
    ]);
  });

  it('puts an empty expansion after every % so no variable name can form', () => {
    expect(spawnArgv('C:\\50%\\x.cmd', ['%PATH%'], 'win').args[4])
      .toBe('"C:\\50%%cd:~,%\\x.cmd ^^^"%%cd:~,%PATH%%cd:~,%^^^""');
  });

  it('runs cmd.exe by its full path, not through the agent\'s PATH', () => {
    const { file } = spawnArgv('C:\\tools\\dsh.cmd', [], 'win');
    expect(path.win32.isAbsolute(file)).toBe(true);
    expect(path.win32.basename(file).toLowerCase()).toBe('cmd.exe');
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
      dir = await mkdtemp(path.join(os.tmpdir(), 'lolping shim (1) & 50% '));
      await writeFile(path.join(dir, 'fake.cmd'), '@node "%~dp0echo.cjs" %*\r\n');
      await writeFile(path.join(dir, 'echo.cjs'), 'process.stdout.write(JSON.stringify(process.argv.slice(2)));\n');
      // A lone quote first: cmd's own quote counting then flips, and only the carets keep the & after it inert.
      const args = [
        'a"b', 'C:\\a b&c', '50%', '%PATH%', '%PATH:C=Q%', '%%', '%CD%', '%~dp0', '100%%PATH%', '!x!', 'a\\\\"b', '^', '(x)', 'C:\\dir\\', 'x|y<z>w', '',
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
    const run = vi.fn(async () => '\n__LPPATH__/opt/homebrew/bin:/usr/bin__LPPATH__');
    expect(await userPath('mac', run)).toBe('/opt/homebrew/bin:/usr/bin');
    expect(await userPath('mac', run)).toBe('/opt/homebrew/bin:/usr/bin');
    expect(run).toHaveBeenCalledTimes(1);
    const [shell, args, ms] = run.mock.calls[0] as unknown as [string, string[], number];
    expect(shell).toBe(process.env.SHELL || '/bin/zsh');
    expect(args.slice(0, 1)).toEqual(['-ilc']);
    expect(args[1]).toContain('__LPPATH__%s__LPPATH__');
    expect(args[1]).toContain('"$PATH"');
    expect(ms).toBe(3000);
  });

  it('takes only what sits between the markers when the shell prints a greeting or a prompt around it', async () => {
    const userPath = await fresh();
    const noise = 'Last login: today\n\u001b[1m\u001b[7m%\u001b[27m\u001b[1m\u001b[0m\n';
    const out = `${noise}\n__LPPATH__/opt/homebrew/bin:/Users/x/.npm/bin:/usr/bin__LPPATH__\u001b[0m\nbye\n`;
    expect(await userPath('mac', async () => out)).toBe('/opt/homebrew/bin:/Users/x/.npm/bin:/usr/bin');
  });

  it('keeps a PATH with spaces whole', async () => {
    const userPath = await fresh();
    expect(await userPath('mac', async () => '\n__LPPATH__/Users/a b/bin:/usr/bin__LPPATH__'))
      .toBe('/Users/a b/bin:/usr/bin');
  });

  it.each(['', 'no markers here\n/usr/bin', '\n__LPPATH____LPPATH__', '__LPPATH__/only/the/start'])(
    'falls back to its own PATH when the output has no usable value: %j', async (out) => {
      const userPath = await fresh();
      expect(await userPath('mac', async () => out)).toBe(process.env.PATH ?? '');
    });

  it('falls back to its own PATH when the shell fails', async () => {
    const userPath = await fresh();
    expect(await userPath('mac', async () => { throw new Error('timed out'); })).toBe(process.env.PATH ?? '');
  });

  it('asks the shell again after a lookup that failed, and keeps the first one that worked', async () => {
    const userPath = await fresh();
    const answers = [
      async (): Promise<string> => { throw new Error('timed out'); },
      async () => 'no markers',
      async () => '__LPPATH__/opt/homebrew/bin__LPPATH__',
    ];
    const run = vi.fn(async () => (answers.shift() ?? (async () => 'unused'))());
    expect(await userPath('mac', run)).toBe(process.env.PATH ?? '');
    expect(await userPath('mac', run)).toBe(process.env.PATH ?? '');
    expect(await userPath('mac', run)).toBe('/opt/homebrew/bin');
    expect(await userPath('mac', run)).toBe('/opt/homebrew/bin');
    expect(run).toHaveBeenCalledTimes(3);
  });

  it('uses its own PATH on Windows and Linux without running a shell', async () => {
    const userPath = await fresh();
    const run = vi.fn(async () => '/elsewhere');
    expect(await userPath('win', run)).toBe(process.env.PATH ?? '');
    expect(await userPath('linux', run)).toBe(process.env.PATH ?? '');
    expect(run).not.toHaveBeenCalled();
  });
});

describe('withPath', () => {
  it('replaces whichever PATH key Windows uses and keeps the rest', () => {
    const env = { Path: 'C:\\old', SystemRoot: 'C:\\Windows', ComSpec: 'C:\\Windows\\System32\\cmd.exe' };
    expect(withPath(env, 'C:\\new', 'win')).toEqual({ ...env, Path: 'C:\\new' });
    expect(withPath({ PATH: 'C:\\old' }, 'C:\\new', 'win')).toEqual({ PATH: 'C:\\new' });
    expect(withPath({}, 'C:\\new', 'win')).toEqual({ Path: 'C:\\new' });
  });

  it('sets PATH by its exact name on macOS and Linux', () => {
    expect(withPath({ HOME: '/Users/a', PATH: '/usr/bin' }, '/opt/homebrew/bin:/usr/bin', 'mac'))
      .toEqual({ HOME: '/Users/a', PATH: '/opt/homebrew/bin:/usr/bin' });
  });
});

import type { Platform } from '../../../shared/platform';
import { posixQuote } from '../../../shared/teammate/quote';
import { cmdLine, forCmd, quoteArgument, system32 } from './command';

// Terminal types the line into an interactive shell, where Ctrl-U, Esc and the like edit the line instead of being
// quoted text, so no quoting can make a control character safe.
const CONTROL = /[\u0000-\u001f\u007f]/;

function posixLine(cwd: string, file: string, args: readonly string[]): string {
  if ([cwd, file, ...args].some((a) => CONTROL.test(a))) throw new Error('A terminal line can\'t hold a control character');
  return `cd ${posixQuote(cwd)} && ${[file, ...args].map(posixQuote).join(' ')}`;
}

/** argv that opens a terminal in `cwd` running `file args`; no shell string carries user text unquoted. */
export function terminalArgv(platform: Platform, cwd: string, file: string, args: readonly string[]):
  { file: string; args: string[]; verbatim: boolean } {
  if (platform === 'win') {
    const cmd = system32('cmd.exe');
    // Two cmd.exe read this line, the one running `start` and the one `start` opens, so each word is escaped for the
    // first and `cmdLine` has escaped the command for the second. `/s` makes the opened cmd keep the quotes inside.
    // Node must pass the line as it is: its own quoting would put backslashes before the quotes. /v:off on both, as
    // in spawnArgv, so a `!` stays literal.
    return {
      file: cmd,
      args: [
        '/d', '/v:off', '/c', 'start', '""', '/d', forCmd(quoteArgument(cwd)), forCmd(quoteArgument(cmd)),
        '/d', '/v:off', '/s', '/k', forCmd(`"${cmdLine(file, args)}"`),
      ],
      verbatim: true,
    };
  }
  const line = posixLine(cwd, file, args);
  if (platform === 'mac') {
    // The shell line sits inside an AppleScript string, where \ and " need a backslash.
    const script = line.replace(/[\\"]/g, '\\$&');
    return {
      file: 'osascript', verbatim: false,
      args: [
        '-e', `tell application "Terminal" to do script "${script}"`, '-e', 'tell application "Terminal" to activate',
      ],
    };
  }
  return { file: 'x-terminal-emulator', args: ['-e', 'sh', '-c', line], verbatim: false };
}

/** The part of child_process.spawn that launchTerminal uses, so a test can stand in for it. */
export type LaunchSpawn = (
  file: string, args: string[],
  options: { detached: true; stdio: 'ignore'; env: NodeJS.ProcessEnv; windowsVerbatimArguments: boolean },
) => LaunchChild;

/** What launchTerminal listens to on the launcher's process. */
export interface LaunchChild {
  on(event: 'error', listener: () => void): unknown;
  on(event: 'spawn', listener: () => void): unknown;
  on(event: 'exit', listener: (code: number | null) => void): unknown;
  unref(): void;
}

/** Opens the terminal; false when the line can't be made, the launcher can't start or it exits with an error. */
export function launchTerminal(o: {
  spawn: LaunchSpawn; platform: Platform; cwd: string; file: string; args: readonly string[]; env: NodeJS.ProcessEnv;
}): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const t = terminalArgv(o.platform, o.cwd, o.file, o.args);
      const child = o.spawn(t.file, t.args, {
        detached: true, stdio: 'ignore', env: o.env, windowsVerbatimArguments: t.verbatim,
      });
      child.on('error', () => resolve(false));
      // start and osascript exit once the window is open; x-terminal-emulator may stay until the window closes.
      if (o.platform === 'linux') child.on('spawn', () => resolve(true));
      else child.on('exit', (code) => resolve(code === 0));
      child.unref();
    } catch {
      resolve(false);
    }
  });
}

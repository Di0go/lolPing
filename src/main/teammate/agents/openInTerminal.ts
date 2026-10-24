import type { Platform } from '../../../shared/platform';
import { cmdLine, forCmd, quoteArgument, system32 } from './command';

/** One word for a POSIX shell: single quotes keep every character as it is. */
const posixQuote = (v: string): string => `'${v.replace(/'/g, '\'\\\'\'')}'`;

const posixLine = (cwd: string, file: string, args: readonly string[]): string =>
  `cd ${posixQuote(cwd)} && ${[file, ...args].map(posixQuote).join(' ')}`;

/** argv that opens a terminal in `cwd` running `file args`; no shell string carries user text unquoted. */
export function terminalArgv(platform: Platform, cwd: string, file: string, args: readonly string[]):
  { file: string; args: string[]; verbatim: boolean } {
  if (platform === 'win') {
    const cmd = system32('cmd.exe');
    // Two cmd.exe read this line, the one running `start` and the one `start` opens, so each word is escaped for the
    // first and `cmdLine` has escaped the command for the second. `/s` makes the opened cmd keep the quotes inside.
    // Node must pass the line as it is: its own quoting would put backslashes before the quotes.
    return {
      file: cmd,
      args: [
        '/d', '/c', 'start', '""', '/d', forCmd(quoteArgument(cwd)), forCmd(quoteArgument(cmd)),
        '/d', '/s', '/k', forCmd(`"${cmdLine(file, args)}"`),
      ],
      verbatim: true,
    };
  }
  const line = posixLine(cwd, file, args);
  if (platform === 'mac') {
    // The shell line sits inside an AppleScript string, where \ and " need a backslash.
    const script = line.replace(/[\\"]/g, '\\$&');
    return { file: 'osascript', args: ['-e', `tell application "Terminal" to do script "${script}"`], verbatim: false };
  }
  return { file: 'x-terminal-emulator', args: ['-e', 'sh', '-c', line], verbatim: false };
}

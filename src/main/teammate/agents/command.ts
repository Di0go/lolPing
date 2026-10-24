import path from 'node:path';
import type { Platform } from '../../../shared/platform';

const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD';
const SHELL_PATH_MS = 3000;

/** The executable for `command`: a path as is, else the first PATH entry with a PATHEXT match (Windows) or the name. */
export function findExecutable(command: string, env: { PATH: string; PATHEXT?: string }, platform: Platform,
  exists: (p: string) => boolean): string | null {
  const win = platform === 'win';
  const paths = win ? path.win32 : path.posix;
  const exts = (env.PATHEXT || DEFAULT_PATHEXT).split(';').filter((e) => e !== '').map((e) => e.toLowerCase());
  // npm puts an sh script without an extension beside each .cmd shim; Windows can't run it, so PATHEXT comes first.
  const candidates = (base: string, asIs: boolean): string[] =>
    (win ? [...exts.map((e) => base + e), ...(asIs ? [base] : [])] : [base]);
  const pick = (base: string, asIs: boolean): string | null => candidates(base, asIs).find(exists) ?? null;

  const hasExt = paths.extname(command) !== '';
  if (paths.isAbsolute(command) || (win ? /[\\/]/ : /\//).test(command)) return pick(command, true);
  for (const entry of env.PATH.split(win ? ';' : ':')) {
    const dir = win ? entry.replace(/^"(.*)"$/, '$1') : entry;
    if (dir === '') continue;
    const found = pick(paths.join(dir, command), hasExt);
    if (found !== null) return found;
  }
  return null;
}

// cmd's metacharacters, as cross-spawn escapes them.
const CMD_META = /([()\][%!^"`<>&|;, *?])/g;

const caret = (text: string): string => text.replace(CMD_META, '^$1');

/** Quotes one argument the way the C runtime splits a command line (backslashes double only before a quote). */
function quoteArgument(arg: string): string {
  let out = '"';
  let slashes = 0;
  for (const ch of arg) {
    if (ch === '\\') {
      slashes += 1;
      continue;
    }
    out += ch === '"' ? `${'\\'.repeat(slashes * 2 + 1)}"` : `${'\\'.repeat(slashes)}${ch}`;
    slashes = 0;
  }
  return `${out}${'\\'.repeat(slashes * 2)}"`;
}

/** argv for spawn: a .cmd/.bat becomes cmd.exe /d /s /c "<quoted line>"; anything else is passed as is. */
export function spawnArgv(file: string, args: readonly string[], platform: Platform):
  { file: string; args: string[]; verbatim: boolean } {
  if (platform !== 'win' || !/\.(cmd|bat)$/i.test(file)) return { file, args: [...args], verbatim: false };
  // cmd ends a command at a line break whatever the quoting, so the rest of the line would run as a new command.
  if ([file, ...args].some((a) => /[\r\n]/.test(a))) throw new Error('A .cmd argument can\'t hold a line break');
  // Carets twice: cmd /c takes one level, and the shim's `%*` is parsed again and takes the other.
  const line = [caret(file), ...args.map((a) => caret(caret(quoteArgument(a))))].join(' ');
  return { file: 'cmd.exe', args: ['/d', '/s', '/c', `"${line}"`], verbatim: true };
}

let shellPath: Promise<string> | null = null;

/** macOS: PATH from `$SHELL -ilc 'printf %s "$PATH"'` (3 s limit), cached; elsewhere process.env.PATH. */
export function userPath(platform: Platform, run: (cmd: string, args: string[], ms: number) => Promise<string>):
  Promise<string> {
  const own = process.env.PATH ?? '';
  if (platform !== 'mac') return Promise.resolve(own);
  // Apps started from Finder get launchd's short PATH, without Homebrew or npm's folders.
  shellPath ??= run(process.env.SHELL || '/bin/zsh', ['-ilc', 'printf %s "$PATH"'], SHELL_PATH_MS).then(
    // An interactive shell may print a greeting first; PATH is the last line.
    (out) => out.split('\n').pop()?.trim() || own,
    () => own,
  );
  return shellPath;
}

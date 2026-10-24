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
  // A name with an extension is tried as is first. npm puts an sh script without one beside each .cmd shim, which
  // Windows can't run, so for a bare name PATHEXT comes first.
  const candidates = (base: string, asIs: boolean): string[] => {
    if (!win) return [base];
    const suffixed = exts.map((e) => base + e);
    if (paths.extname(base) !== '') return [base, ...suffixed];
    return asIs ? [...suffixed, base] : suffixed;
  };
  const pick = (base: string, asIs: boolean): string | null => candidates(base, asIs).find(exists) ?? null;

  if (paths.isAbsolute(command) || (win ? /[\\/]/ : /\//).test(command)) return pick(command, true);
  for (const entry of env.PATH.split(win ? ';' : ':')) {
    const dir = win ? entry.replace(/^"(.*)"$/, '$1') : entry;
    if (dir === '') continue;
    const found = pick(paths.join(dir, command), false);
    if (found !== null) return found;
  }
  return null;
}

/** A Windows tool by absolute path from lolPing's own environment, so a folder on the agent's PATH can't stand in. */
export function system32(exe: string): string {
  const root = process.env.SystemRoot;
  return path.win32.join(root !== undefined && path.win32.isAbsolute(root) ? root : 'C:\\Windows', 'System32', exe);
}

function cmdExe(): string {
  const spec = process.env.ComSpec;
  const ok = spec !== undefined && path.win32.isAbsolute(spec) && path.win32.basename(spec).toLowerCase() === 'cmd.exe';
  return ok ? spec : system32('cmd.exe');
}

// cmd's metacharacters, as cross-spawn escapes them; % is handled apart, see noExpand.
const CMD_META = /([()\][!^"`<>&|;, *?])/g;

const caret = (text: string): string => text.replace(CMD_META, '^$1');

// cmd /c expands %NAME% (and %NAME:a=b%) before it reads any caret. After each % comes %cd:~,%, which expands to
// nothing, so no variable name can start at the % (Rust's std does the same for .bat arguments).
const noExpand = (text: string): string => text.replace(/%/g, '%%cd:~,%');

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
  // Carets twice on arguments: cmd /c takes one level, and the shim's `%*` is parsed again and takes the other.
  const line = [file, ...args.map((a) => caret(quoteArgument(a)))].map((a) => noExpand(caret(a))).join(' ');
  return { file: cmdExe(), args: ['/d', '/s', '/c', `"${line}"`], verbatim: true };
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

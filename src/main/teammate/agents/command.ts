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

/** `text` for one more cmd.exe parse: its metacharacters and % lose their meaning and the next reader gets `text`. */
export const forCmd = (text: string): string => noExpand(caret(text));

/** Quotes one argument the way the C runtime splits a command line (backslashes double only before a quote). */
export function quoteArgument(arg: string): string {
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

const isShim = (file: string): boolean => /\.(cmd|bat)$/i.test(file);

/** The line cmd.exe reads to run `file args` with every argument kept whole (for a shim, through its `%*` too). */
export function cmdLine(file: string, args: readonly string[]): string {
  // cmd ends a command at a line break whatever the quoting, so the rest of the line would run as a new command.
  if ([file, ...args].some((a) => /[\r\n]/.test(a))) throw new Error('A cmd.exe argument can\'t hold a line break');
  // Carets twice on a shim's arguments: cmd takes one level, and the shim's `%*` is parsed again and takes the other.
  if (isShim(file)) return [file, ...args.map((a) => caret(quoteArgument(a)))].map(forCmd).join(' ');
  return [file, ...args].map((a) => forCmd(quoteArgument(a))).join(' ');
}

/**
 * argv for spawn: a .cmd/.bat becomes cmd.exe /d /v:off /s /c "<quoted line>"; anything else is passed as is. /v:off
 * keeps a `!` literal even where the registry turns delayed expansion on.
 */
export function spawnArgv(file: string, args: readonly string[], platform: Platform):
  { file: string; args: string[]; verbatim: boolean } {
  if (platform !== 'win' || !isShim(file)) return { file, args: [...args], verbatim: false };
  return { file: cmdExe(), args: ['/d', '/v:off', '/s', '/c', `"${cmdLine(file, args)}"`], verbatim: true };
}

/** `env` with PATH set to `value`. Windows names ignore case: the key it has is replaced, so there are never two. */
export function withPath(env: NodeJS.ProcessEnv, value: string, platform: Platform): NodeJS.ProcessEnv {
  const key = platform === 'win' ? Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'Path' : 'PATH';
  return { ...env, [key]: value };
}

/** The login shell's PATH, or null when it gave none; a lookup in flight is shared, a failed one isn't kept. */
let shellPath: Promise<string | null> | null = null;

// A login shell's startup files may print a greeting or escape codes; the markers say where PATH is.
const PATH_MARK = '__LPPATH__';
const PATH_SCRIPT = `printf '${PATH_MARK}%s${PATH_MARK}' "$PATH"`;
const markedPath = (out: string): string | null => {
  const start = out.indexOf(PATH_MARK);
  const end = start === -1 ? -1 : out.indexOf(PATH_MARK, start + PATH_MARK.length);
  const value = end === -1 ? '' : out.slice(start + PATH_MARK.length, end).trim();
  return value === '' ? null : value;
};

/**
 * macOS: PATH from `$SHELL -ilc` (3 s limit), cached once it worked; elsewhere process.env.PATH. A lookup that failed
 * (a slow shell at login, say) gives lolPing's own PATH this time and is tried again the next time.
 */
export function userPath(platform: Platform, run: (cmd: string, args: string[], ms: number) => Promise<string>):
  Promise<string> {
  const own = process.env.PATH ?? '';
  if (platform !== 'mac') return Promise.resolve(own);
  // Apps started from Finder get launchd's short PATH, without Homebrew or npm's folders.
  shellPath ??= run(process.env.SHELL || '/bin/zsh', ['-ilc', PATH_SCRIPT], SHELL_PATH_MS).then(
    (out) => markedPath(out),
    () => null,
  ).then((found) => {
    if (found === null) shellPath = null;
    return found;
  });
  return shellPath.then((found) => found ?? own);
}

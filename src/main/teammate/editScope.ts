import path from 'node:path';
import type { Platform } from '../../shared/platform';

/** Folders whose files make tools run commands (hooks, tasks, an agent's own permissions): an edit there is one. */
const SETTINGS_DIRS = new Set(['.claude', '.git', '.vscode', '.idea']);

/** Windows opens `.git.`, `.git ` and `GIT~1` as `.git`, and `x:stream` as a stream of x: such a name can't be read. */
const WIN_ALIAS = /:|~\d/;

/**
 * Whether a saved Always allow covers an agent's edit of `file`: inside the run's folder `cwd`, in none of its settings
 * folders at any depth, and not a dot file or folder of the home folder (a shell profile, ~/.ssh). A run in the home
 * folder, or in a folder holding it, is never covered: startup folders and shell profiles live there without a dot.
 * Anything else always asks, since an edit there runs commands by another name. Without case on Windows and macOS.
 */
export function alwaysAllowsEdit(file: string, cwd: string | null, home: string, platform: Platform): boolean {
  if (cwd === null || file === '') return false;
  const p = platform === 'win' ? path.win32 : path.posix;
  const fold = (s: string): string => (platform === 'linux' ? s : s.toLowerCase());
  const tilde = platform === 'win' ? /^~(?=$|[\\/])/ : /^~(?=$|\/)/;
  const given = tilde.test(file) ? p.join(home, file.slice(1)) : file;
  const relParts = (from: string, to: string): string[] | null => {
    const rel = p.relative(fold(p.resolve(from)), fold(p.resolve(to)));
    if (rel === '') return [];
    if (p.isAbsolute(rel)) return null;
    const parts = rel.split(p.sep);
    return parts[0] === '..' ? null : parts;
  };
  if (relParts(cwd, home) !== null) return false;
  const parts = relParts(cwd, p.resolve(cwd, given));
  if (!parts || parts.length === 0) return false;
  if (platform === 'win' && parts.some((part) => WIN_ALIAS.test(part))) return false;
  const names = platform === 'win' ? parts.map((part) => part.replace(/[. ]+$/, '')) : parts;
  if (names.some((name) => SETTINGS_DIRS.has(name))) return false;
  return !relParts(home, p.resolve(cwd, given))?.[0]?.startsWith('.');
}

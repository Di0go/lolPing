import path from 'node:path';
import type { Platform } from '../../shared/platform';

/** Folders whose files make tools run commands (hooks, tasks, an agent's own permissions): an edit there is one. */
const SETTINGS_DIRS = new Set(['.claude', '.git', '.vscode', '.idea']);

/**
 * Whether a saved Always allow covers an agent's edit of `file`: inside the run's folder `cwd`, in none of its settings
 * folders at any depth, and not a dot file or folder of the home folder (a shell profile, ~/.ssh). Anything else always
 * asks, since an edit there runs commands by another name. Without case on Windows and macOS.
 */
export function alwaysAllowsEdit(file: string, cwd: string | null, home: string, platform: Platform): boolean {
  if (cwd === null || file === '') return false;
  const p = platform === 'win' ? path.win32 : path.posix;
  const fold = (s: string): string => (platform === 'linux' ? s : s.toLowerCase());
  const tilde = platform === 'win' ? /^~(?=$|[\\/])/ : /^~(?=$|\/)/;
  const given = tilde.test(file) ? p.join(home, file.slice(1)) : file;
  const target = fold(p.resolve(cwd, given));
  const within = (dir: string): string[] | null => {
    const rel = p.relative(fold(p.resolve(dir)), target);
    if (rel === '' || p.isAbsolute(rel)) return null;
    const parts = rel.split(p.sep);
    return parts[0] === '..' ? null : parts;
  };
  const parts = within(cwd);
  if (!parts || parts.some((part) => SETTINGS_DIRS.has(part))) return false;
  return !within(home)?.[0]?.startsWith('.');
}

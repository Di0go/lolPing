import path from 'node:path';
import type { Platform } from '../../shared/platform';
import { editorFamily } from '../../shared/teammate/editorFolder';
import { findExecutable } from './agents/command';

export interface EditorProbe {
  platform: Platform;
  env: {
    PATH: string; PATHEXT?: string; LOCALAPPDATA?: string; ProgramFiles?: string;
  };
  home: string;
  exists(p: string): boolean;
  /** The names in a folder; none when it isn't there. */
  list(dir: string): string[];
}

/** The IDEs' Windows launchers; the foreground app is named after one ("idea64"). */
const JETBRAINS_EXE = [
  'idea64', 'pycharm64', 'webstorm64', 'goland64', 'clion64', 'rider64', 'phpstorm64', 'rubymine64', 'datagrip64',
  'rustrover64',
];

/**
 * The editors that have app rules worth suggesting (VS Code, Cursor, the JetBrains IDEs), named as the helper names the
 * foreground app. Best effort: default install folders and PATH; an IDE put elsewhere is simply not suggested.
 */
export function installedEditors(p: EditorProbe): string[] {
  const found: string[] = [];
  const add = (name: string): void => {
    if (!found.includes(name)) found.push(name);
  };
  const onPath = (command: string): boolean => findExecutable(command, p.env, p.platform, p.exists) !== null;

  if (p.platform === 'mac') {
    const user = path.posix.join(p.home, 'Applications');
    for (const dir of ['/Applications', user, path.posix.join(user, 'JetBrains Toolbox')]) {
      for (const entry of p.list(dir)) {
        if (!entry.endsWith('.app')) continue;
        const name = entry.slice(0, -'.app'.length);
        if (name === 'Visual Studio Code') add('Code');
        else if (name === 'Cursor' || editorFamily(name) === 'jetbrains') add(name);
      }
    }
    return found;
  }

  if (p.platform === 'win') {
    const w = path.win32;
    const { LOCALAPPDATA: local, ProgramFiles: files } = p.env;
    const under = (base: string | undefined, ...rest: string[]): string[] => (base ? [w.join(base, ...rest)] : []);
    if ([...under(local, 'Programs', 'Microsoft VS Code', 'Code.exe'), ...under(files, 'Microsoft VS Code', 'Code.exe')]
      .some(p.exists) || onPath('code')) add('Code');
    if (under(local, 'Programs', 'cursor', 'Cursor.exe').some(p.exists) || onPath('cursor')) add('Cursor');
    const roots = [...under(files, 'JetBrains'), ...under(local, 'Programs')];
    for (const exe of JETBRAINS_EXE) {
      const at = (root: string, dir: string): string => w.join(root, dir, 'bin', `${exe}.exe`);
      const installed = roots.some((root) => p.list(root).some((dir) => p.exists(at(root, dir))));
      if (installed || onPath(exe)) add(exe);
    }
    return found;
  }

  if (onPath('code')) add('Code');
  if (onPath('cursor')) add('Cursor');
  return found;
}

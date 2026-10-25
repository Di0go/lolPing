import type { Platform } from '../platform';

export type EditorFamily = 'vscode' | 'jetbrains';

const VSCODE = new Set(['code', 'code - insiders', 'cursor', 'windsurf', 'vscodium']);
const JETBRAINS_WIN = /^(idea|pycharm|webstorm|goland|clion|rider|phpstorm|rubymine|datagrip|rustrover)(64)?$/;
// macOS names carry the product name and an optional edition ("IntelliJ IDEA CE").
const JETBRAINS_MAC =
  /^(intellij idea|pycharm|webstorm|goland|clion|rider|phpstorm|rubymine|datagrip|rustrover)( .*)?$/;

/** Which editor family the foreground app is, by its name as the helper reports it ("Code", "idea64", "PyCharm"). */
export function editorFamily(app: string): EditorFamily | null {
  const name = app.trim().toLowerCase().replace(/\.exe$/, '');
  if (VSCODE.has(name)) return 'vscode';
  if (JETBRAINS_WIN.test(name) || JETBRAINS_MAC.test(name)) return 'jetbrains';
  return null;
}

const WORKSPACE_SUFFIX = ' (Workspace)';
const DIRTY_MARK = '● ';

/** The title parts that can name the project: VS Code puts it before the app name, JetBrains first. */
function titleParts(family: EditorFamily, title: string, platform: Platform): string[] {
  const t = title.startsWith(DIRTY_MARK) ? title.slice(DIRTY_MARK.length) : title;
  // The last VS Code part is the app name.
  const parts = family === 'vscode'
    ? t.split(platform === 'mac' ? ' — ' : ' - ').slice(0, -1)
    : t.split(' – ').slice(0, 1);
  return parts
    .map((p) => (p.endsWith(WORKSPACE_SUFFIX) ? p.slice(0, -WORKSPACE_SUFFIX.length) : p).trim().toLowerCase())
    .filter((p) => p !== '');
}

function baseName(folder: string): string {
  const segments = folder.split(/[\\/]/).filter((s) => s !== '');
  return (segments[segments.length - 1] ?? '').toLowerCase();
}

/** The folder to run in, and whether the title picked it. */
export function editorFolder(
  folders: readonly string[],
  ask: { app: string; title: string },
  platform: Platform,
): { path: string; matched: boolean } | null {
  if (folders.length === 0) return null;
  const family = editorFamily(ask.app);
  if (family) {
    const parts = titleParts(family, ask.title, platform);
    const hits = folders.filter((f) => parts.includes(baseName(f)));
    if (hits.length === 1) return { path: hits[0], matched: true };
  }
  return { path: folders[0], matched: false };
}

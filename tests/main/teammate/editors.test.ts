import { describe, expect, it } from 'vitest';
import { installedEditors, type EditorProbe } from '../../../src/main/teammate/editors';

/** A fake disk: `files` are regular files, and `list` gives a folder's entries from them. */
function probe(platform: EditorProbe['platform'], files: string[], env: Partial<EditorProbe['env']> = {}): EditorProbe {
  const sep = platform === 'win' ? '\\' : '/';
  const all = new Set(files.map((f) => f.toLowerCase()));
  return {
    platform,
    env: { PATH: '', ...env },
    home: platform === 'win' ? 'C:\\Users\\me' : '/Users/me',
    exists: (p) => all.has(p.toLowerCase()) || files.some((f) => f.toLowerCase().startsWith(`${p.toLowerCase()}${sep}`)),
    list: (dir) => {
      const prefix = `${dir.toLowerCase()}${sep}`;
      const names = files.filter((f) => f.toLowerCase().startsWith(prefix)).map((f) => f.slice(prefix.length).split(sep)[0]);
      return [...new Set(names)];
    },
  };
}

const WIN_ENV = { LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local', ProgramFiles: 'C:\\Program Files' };

describe('installedEditors on Windows', () => {
  it('finds VS Code and Cursor in their per-user install folders', () => {
    const p = probe('win', [
      'C:\\Users\\me\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe',
      'C:\\Users\\me\\AppData\\Local\\Programs\\cursor\\Cursor.exe',
    ], WIN_ENV);
    expect(installedEditors(p)).toEqual(['Code', 'Cursor']);
  });

  it('finds an editor on PATH through its launcher', () => {
    const p = probe('win', ['D:\\tools\\code.cmd', 'D:\\tools\\idea64.exe'], { ...WIN_ENV, PATH: 'D:\\tools', PATHEXT: '.EXE;.CMD' });
    expect(installedEditors(p)).toEqual(['Code', 'idea64']);
  });

  it('names JetBrains IDEs by their executable, the way the helper reports them', () => {
    const p = probe('win', [
      'C:\\Program Files\\JetBrains\\IntelliJ IDEA 2025.2\\bin\\idea64.exe',
      'C:\\Users\\me\\AppData\\Local\\Programs\\PyCharm\\bin\\pycharm64.exe',
      'C:\\Program Files\\JetBrains\\IntelliJ IDEA 2025.2\\bin\\fsnotifier.exe',
    ], WIN_ENV);
    expect(installedEditors(p)).toEqual(['idea64', 'pycharm64']);
  });

  it('lists each editor once even when it is found twice', () => {
    const p = probe('win', [
      'C:\\Users\\me\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe', 'D:\\tools\\code.cmd',
    ], { ...WIN_ENV, PATH: 'D:\\tools', PATHEXT: '.CMD' });
    expect(installedEditors(p)).toEqual(['Code']);
  });

  it('finds nothing on a machine without editors', () => {
    expect(installedEditors(probe('win', [], WIN_ENV))).toEqual([]);
  });
});

describe('installedEditors on macOS', () => {
  it('names VS Code Code and JetBrains IDEs by their app name', () => {
    const p = probe('mac', [
      '/Applications/Visual Studio Code.app/Contents/Info.plist',
      '/Applications/Cursor.app/Contents/Info.plist',
      '/Applications/IntelliJ IDEA CE.app/Contents/Info.plist',
      '/Users/me/Applications/PyCharm.app/Contents/Info.plist',
      '/Applications/Safari.app/Contents/Info.plist',
    ]);
    expect(installedEditors(p)).toEqual(['Code', 'Cursor', 'IntelliJ IDEA CE', 'PyCharm']);
  });
});

describe('installedEditors on Linux', () => {
  it('finds VS Code and Cursor on PATH', () => {
    const p = probe('linux', ['/usr/bin/code', '/opt/bin/cursor'], { PATH: '/usr/bin:/opt/bin' });
    expect(installedEditors(p)).toEqual(['Code', 'Cursor']);
  });
});

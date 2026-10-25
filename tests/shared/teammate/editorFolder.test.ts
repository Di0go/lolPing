import { describe, expect, it } from 'vitest';
import { editorFamily, editorFolder } from '../../../src/shared/teammate/editorFolder';

const FOLDERS = ['C:\\work\\other', 'C:\\work\\lp-folder-probe', 'C:\\work\\lp-multi'];

describe('editorFamily', () => {
  it('knows the VS Code family and the JetBrains IDEs by the names the helper reports', () => {
    for (const app of ['Code', 'Code.exe', 'Code - Insiders', 'Cursor', 'Windsurf', 'VSCodium']) {
      expect(editorFamily(app), app).toBe('vscode');
    }
    const jetbrains = ['idea64', 'pycharm64.exe', 'webstorm', 'rustrover64', 'IntelliJ IDEA', 'IntelliJ IDEA CE', 'PyCharm'];
    for (const app of jetbrains) expect(editorFamily(app), app).toBe('jetbrains');
  });

  it('returns null for any other app', () => {
    for (const app of ['chrome', 'notepad', 'Antigravity', 'codex', '']) expect(editorFamily(app), app).toBeNull();
  });
});

describe('editorFolder', () => {
  it('finds the folder in a VS Code and a Cursor title', () => {
    expect(editorFolder(FOLDERS, { app: 'Code', title: 'probe.ts - lp-folder-probe - Visual Studio Code' }, 'win'))
      .toEqual({ path: 'C:\\work\\lp-folder-probe', matched: true });
    expect(editorFolder(FOLDERS, { app: 'Cursor', title: 'probe.ts - lp-folder-probe - Cursor' }, 'win'))
      .toEqual({ path: 'C:\\work\\lp-folder-probe', matched: true });
    expect(editorFolder(FOLDERS, { app: 'Code', title: 'Welcome - LP-FOLDER-PROBE - Visual Studio Code' }, 'linux'))
      .toEqual({ path: 'C:\\work\\lp-folder-probe', matched: true });
  });

  it('finds a workspace by its name', () => {
    expect(editorFolder(FOLDERS, { app: 'Code', title: 'lp-multi (Workspace) - Visual Studio Code' }, 'win'))
      .toEqual({ path: 'C:\\work\\lp-multi', matched: true });
  });

  it('uses the em dash separator on macOS', () => {
    const folders = ['/Users/me/other', '/Users/me/lp-folder-probe/'];
    expect(editorFolder(folders, { app: 'Code', title: 'probe.ts — lp-folder-probe — Visual Studio Code' }, 'mac'))
      .toEqual({ path: '/Users/me/lp-folder-probe/', matched: true });
    // the Windows separator doesn't split a macOS title
    expect(editorFolder(folders, { app: 'Code', title: 'probe.ts - lp-folder-probe - Visual Studio Code' }, 'mac'))
      .toEqual({ path: '/Users/me/other', matched: false });
  });

  it('reads the project first in a JetBrains title', () => {
    expect(editorFolder(FOLDERS, { app: 'idea64', title: 'lp-folder-probe – probe.ts' }, 'win'))
      .toEqual({ path: 'C:\\work\\lp-folder-probe', matched: true });
    // a file named like another folder is not the project
    expect(editorFolder(FOLDERS, { app: 'PyCharm', title: 'lp-multi – lp-folder-probe' }, 'mac'))
      .toEqual({ path: 'C:\\work\\lp-multi', matched: true });
  });

  it('falls back to the first folder when no part of the title matches', () => {
    const single = 'Preview 2026-10-21-ai-teammate-3-hand-test.md - Visual Studio Code';
    expect(editorFolder(FOLDERS, { app: 'Code', title: single }, 'win')).toEqual({ path: 'C:\\work\\other', matched: false });
    expect(editorFolder(FOLDERS, { app: 'Cursor', title: 'Cursor' }, 'win')).toEqual({ path: 'C:\\work\\other', matched: false });
  });

  it('falls back when two folders share the matched name', () => {
    const folders = ['C:\\a\\app', 'D:\\b\\app', 'D:\\b\\lib'];
    expect(editorFolder(folders, { app: 'Code', title: 'x.ts - app - Visual Studio Code' }, 'win'))
      .toEqual({ path: 'C:\\a\\app', matched: false });
  });

  it('ignores the dirty marker', () => {
    expect(editorFolder(FOLDERS, { app: 'Code', title: '● probe.ts - lp-folder-probe - Visual Studio Code' }, 'win'))
      .toEqual({ path: 'C:\\work\\lp-folder-probe', matched: true });
    expect(editorFolder(FOLDERS, { app: 'Code', title: '● lp-folder-probe - Visual Studio Code' }, 'win'))
      .toEqual({ path: 'C:\\work\\lp-folder-probe', matched: true });
  });

  it('uses the first folder for an app that is not an editor, and null with no folders', () => {
    expect(editorFolder(FOLDERS, { app: 'chrome', title: 'lp-folder-probe - Google Chrome' }, 'win'))
      .toEqual({ path: 'C:\\work\\other', matched: false });
    expect(editorFolder([], { app: 'Code', title: 'a - b - Visual Studio Code' }, 'win')).toBeNull();
  });
});

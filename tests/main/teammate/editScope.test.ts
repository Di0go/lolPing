import { describe, expect, it } from 'vitest';
import { alwaysAllowsEdit } from '../../../src/main/teammate/editScope';

const WIN = { cwd: 'C:\\code\\app', home: 'C:\\Users\\me' };
const MAC = { cwd: '/Users/me/Code/app', home: '/Users/me' };

describe('alwaysAllowsEdit', () => {
  it('covers a file inside the run\'s folder, given relative or absolute', () => {
    expect(alwaysAllowsEdit('src\\app.ts', WIN.cwd, WIN.home, 'win')).toBe(true);
    expect(alwaysAllowsEdit('src/app.ts', WIN.cwd, WIN.home, 'win')).toBe(true);
    expect(alwaysAllowsEdit('C:\\code\\app\\README.md', WIN.cwd, WIN.home, 'win')).toBe(true);
    expect(alwaysAllowsEdit('/Users/me/Code/app/src/x.ts', MAC.cwd, MAC.home, 'mac')).toBe(true);
  });

  it('compares without case on Windows and macOS, and with case on Linux', () => {
    expect(alwaysAllowsEdit('c:\\CODE\\App\\x.ts', WIN.cwd, WIN.home, 'win')).toBe(true);
    expect(alwaysAllowsEdit('/users/me/code/APP/x.ts', MAC.cwd, MAC.home, 'mac')).toBe(true);
    expect(alwaysAllowsEdit('/home/me/Code/x.ts', '/home/me/code', '/home/me', 'linux')).toBe(false);
  });

  it('never covers a file outside the folder, or the folder itself', () => {
    expect(alwaysAllowsEdit('..\\outside.txt', WIN.cwd, WIN.home, 'win')).toBe(false);
    expect(alwaysAllowsEdit('src\\..\\..\\outside.txt', WIN.cwd, WIN.home, 'win')).toBe(false);
    expect(alwaysAllowsEdit('C:\\code\\app-other\\x.ts', WIN.cwd, WIN.home, 'win')).toBe(false);
    expect(alwaysAllowsEdit('D:\\x.ts', WIN.cwd, WIN.home, 'win')).toBe(false);
    expect(alwaysAllowsEdit('C:\\code\\app', WIN.cwd, WIN.home, 'win')).toBe(false);
    expect(alwaysAllowsEdit('/etc/hosts', MAC.cwd, MAC.home, 'mac')).toBe(false);
  });

  it('keeps a name that only starts with two dots inside', () => {
    expect(alwaysAllowsEdit('..notes.md', WIN.cwd, WIN.home, 'win')).toBe(true);
  });

  it('never covers a settings folder at any depth inside the folder', () => {
    for (const file of [
      '.claude\\settings.local.json', '.git\\hooks\\pre-commit', '.vscode\\tasks.json', '.idea\\workspace.xml',
      'packages\\web\\.git\\config', '.CLAUDE\\settings.json', '.git',
    ]) {
      expect(alwaysAllowsEdit(file, WIN.cwd, WIN.home, 'win'), file).toBe(false);
    }
    expect(alwaysAllowsEdit('/Users/me/Code/app/.Vscode/settings.json', MAC.cwd, MAC.home, 'mac')).toBe(false);
    expect(alwaysAllowsEdit('src/.github/x.yml', MAC.cwd, MAC.home, 'mac')).toBe(true);
  });

  it('never covers a dot file or folder of the home folder, even when the agent runs there', () => {
    expect(alwaysAllowsEdit('~/.zshrc', MAC.home, MAC.home, 'mac')).toBe(false);
    expect(alwaysAllowsEdit('/Users/me/.zshrc', MAC.home, MAC.home, 'mac')).toBe(false);
    expect(alwaysAllowsEdit('.bashrc', '/home/me', '/home/me', 'linux')).toBe(false);
    expect(alwaysAllowsEdit('/home/me/.ssh/authorized_keys', '/home/me', '/home/me', 'linux')).toBe(false);
    expect(alwaysAllowsEdit('~\\.gitconfig', WIN.home, WIN.home, 'win')).toBe(false);
    expect(alwaysAllowsEdit('~/.zshrc', MAC.cwd, MAC.home, 'mac')).toBe(false);
    expect(alwaysAllowsEdit('/Users/me/.config/app/x.json', '/Users/me/.config/app', MAC.home, 'mac')).toBe(false);
    expect(alwaysAllowsEdit('/Users/me/Code/app/.eslintrc', MAC.cwd, MAC.home, 'mac')).toBe(true);
  });

  it('never covers an edit when the agent runs in the home folder or a folder holding it', () => {
    // Startup folders, shell profiles and launch agents live in home without a leading dot.
    expect(alwaysAllowsEdit('notes.md', MAC.home, MAC.home, 'mac')).toBe(false);
    expect(alwaysAllowsEdit('Library/LaunchAgents/x.plist', MAC.home, MAC.home, 'mac')).toBe(false);
    expect(alwaysAllowsEdit(
      'AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\x.cmd', WIN.home, WIN.home, 'win',
    )).toBe(false);
    expect(alwaysAllowsEdit('Documents\\PowerShell\\Microsoft.PowerShell_profile.ps1', 'c:\\users\\ME', WIN.home, 'win'))
      .toBe(false);
    expect(alwaysAllowsEdit('me\\notes.md', 'C:\\Users', WIN.home, 'win')).toBe(false);
    expect(alwaysAllowsEdit('Users\\me\\notes.md', 'C:\\', WIN.home, 'win')).toBe(false);
    expect(alwaysAllowsEdit('/home/me/notes.md', '/', '/home/me', 'linux')).toBe(false);
  });

  it('reads Windows aliases of a settings folder as that folder', () => {
    for (const file of [
      '.git.\\hooks\\pre-commit', '.git \\hooks\\x', '.git. . \\hooks\\x', 'GIT~1\\hooks\\x',
      '.git::$INDEX_ALLOCATION\\hooks\\x', '.claude.\\settings.local.json', 'src\\a~1\\x.ts', 'src\\x.ts:stream',
    ]) {
      expect(alwaysAllowsEdit(file, WIN.cwd, WIN.home, 'win'), file).toBe(false);
    }
    expect(alwaysAllowsEdit('src\\notes~draft.md', WIN.cwd, WIN.home, 'win')).toBe(true);
    // Only Windows reads them that way: a trailing dot is a different folder on macOS.
    expect(alwaysAllowsEdit('src/v1./x.ts', MAC.cwd, MAC.home, 'mac')).toBe(true);
  });

  it('never covers an edit without a folder or a file', () => {
    expect(alwaysAllowsEdit('src\\app.ts', null, WIN.home, 'win')).toBe(false);
    expect(alwaysAllowsEdit('', WIN.cwd, WIN.home, 'win')).toBe(false);
  });
});

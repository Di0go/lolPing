import { execFile } from 'node:child_process';

/**
 * KDE Plasma on Wayland: KWin ignores an XWayland window's own always-on-top hint against Wayland windows, so a
 * window rule puts the overlay in KWin's overlay layer, over every app, full-screen ones included. The rule is
 * visible (and removable) in System Settings > Window Rules.
 */
export const KWIN_RULE_ID = 'lolping-overlay';
export const KWIN_RULE: Readonly<Record<string, string>> = {
  Description: 'lolPing overlay (added by lolPing)',
  wmclass: 'lolping',
  wmclassmatch: '1', // exact
  title: 'lolPing overlay', // the overlay page's <title>
  titlematch: '1',
  layer: 'overlay',
  layerrule: '2', // force
};

/** KWin's rule order (Plasma 6: [General] Order=a,b) with the overlay rule in it, or null when it is there already. */
export function withOverlayRule(rules: string): string | null {
  const ids = rules.split(',').map((id) => id.trim()).filter(Boolean);
  return ids.includes(KWIN_RULE_ID) ? null : [...ids, KWIN_RULE_ID].join(',');
}

export const isKdeWayland = (env: NodeJS.ProcessEnv): boolean =>
  !!env.WAYLAND_DISPLAY && (env.XDG_CURRENT_DESKTOP ?? '').split(':').includes('KDE');

type Run = (cmd: string, args: string[]) => Promise<string>;
const run: Run = (cmd, args) =>
  new Promise((resolve, reject) => execFile(cmd, args, { timeout: 5000 }, (err, out) => (err ? reject(err) : resolve(out))));

/** Adds the overlay rule to kwinrulesrc once and asks KWin to reload. Never throws: without it pings just sit lower. */
export async function ensureKWinRule(exec: Run = run): Promise<boolean> {
  try {
    const read = (key: string): Promise<string> =>
      exec('kreadconfig6', ['--file', 'kwinrulesrc', '--group', 'General', '--key', key]).then((s) => s.trim());
    const write = (group: string, key: string, value: string): Promise<string> =>
      exec('kwriteconfig6', ['--file', 'kwinrulesrc', '--group', group, '--key', key, value]);
    const order = withOverlayRule(await read('Order'));
    if (order === null) return false;
    for (const [key, value] of Object.entries(KWIN_RULE)) await write(KWIN_RULE_ID, key, value);
    await write('General', 'Order', order);
    await exec('busctl', ['--user', 'call', 'org.kde.KWin', '/KWin', 'org.kde.KWin', 'reconfigure']);
    return true;
  } catch {
    return false;
  }
}

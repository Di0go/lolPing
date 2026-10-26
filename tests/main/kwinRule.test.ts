import { describe, expect, it } from 'vitest';
import { ensureKWinRule, isKdeWayland, KWIN_RULE_ID, withOverlayRule } from '../../src/main/kwinRule';

/** An in-memory kwinrulesrc driven through the same command lines as kreadconfig6 / kwriteconfig6. */
function fakeKdeConfig(initial: Record<string, Record<string, string>> = {}) {
  const groups = structuredClone(initial);
  const calls: string[] = [];
  const exec = async (cmd: string, args: string[]): Promise<string> => {
    calls.push(cmd);
    const arg = (name: string): string => args[args.indexOf(name) + 1];
    if (cmd === 'kreadconfig6') return (groups[arg('--group')] ?? {})[arg('--key')] ?? '';
    if (cmd === 'kwriteconfig6') (groups[arg('--group')] ??= {})[arg('--key')] = args[args.length - 1];
    return '';
  };
  return { groups, calls, exec };
}

describe('kwinRule', () => {
  it('adds the overlay rule next to the rules the user already has', async () => {
    const kde = fakeKdeConfig({ General: { Order: 'steam,mine' } });
    expect(await ensureKWinRule(kde.exec)).toBe(true);
    expect(kde.groups.General).toEqual({ Order: `steam,mine,${KWIN_RULE_ID}` });
    expect(kde.groups[KWIN_RULE_ID]).toMatchObject({ wmclass: 'lolping', title: 'lolPing overlay', layer: 'overlay', layerrule: '2' });
    expect(kde.calls).toContain('busctl');
  });
  it('creates the list when there are no rules yet', async () => {
    const kde = fakeKdeConfig();
    await ensureKWinRule(kde.exec);
    expect(kde.groups.General).toEqual({ Order: KWIN_RULE_ID });
  });
  it('leaves the file and KWin alone when the rule is already there', async () => {
    const kde = fakeKdeConfig({ General: { Order: `steam,${KWIN_RULE_ID}` } });
    expect(await ensureKWinRule(kde.exec)).toBe(false);
    expect(kde.calls).toEqual(['kreadconfig6']);
  });
  it('gives up quietly when the KDE tools are missing', async () => {
    expect(await ensureKWinRule(async () => { throw new Error('ENOENT'); })).toBe(false);
  });
  it('reads a rules list with spaces and empty entries', () => {
    expect(withOverlayRule(' a , ,b ')).toBe(`a,b,${KWIN_RULE_ID}`);
    expect(withOverlayRule(`a,${KWIN_RULE_ID}`)).toBeNull();
  });
  it('is only for KDE on Wayland', () => {
    expect(isKdeWayland({ WAYLAND_DISPLAY: 'wayland-0', XDG_CURRENT_DESKTOP: 'KDE' })).toBe(true);
    expect(isKdeWayland({ XDG_CURRENT_DESKTOP: 'KDE' })).toBe(false);
    expect(isKdeWayland({ WAYLAND_DISPLAY: 'wayland-0', XDG_CURRENT_DESKTOP: 'GNOME' })).toBe(false);
  });
});

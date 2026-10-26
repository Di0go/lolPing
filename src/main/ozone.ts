/**
 * Electron picks its Ozone platform before the main script runs, so `app.commandLine.appendSwitch('ozone-platform')`
 * reaches only the child processes: under a Wayland session the app itself starts as a Wayland client, where the
 * overlay can't be placed, kept on top or matched by the KWin rule. The arguments to start again under XWayland
 * (for `app.relaunch`), or null when this start already chose a platform or there is no XWayland to use.
 */
export function x11RelaunchArgs(argv: readonly string[], env: NodeJS.ProcessEnv): string[] | null {
  if (!env.WAYLAND_DISPLAY || !env.DISPLAY) return null;
  if (argv.some((a) => a === '--ozone-platform' || a.startsWith('--ozone-platform='))) return null;
  return [...argv.slice(1), '--ozone-platform=x11'];
}

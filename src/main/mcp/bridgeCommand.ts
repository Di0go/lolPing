import path from 'node:path';
import type { Platform } from '../../shared/platform';
import { mcpServersJson } from '../../shared/teammate/connectApps';
import pkg from '../../../package.json';

/** How an agent starts the bridge: the app's executable as Node, with bridge.js. */
export function bridgeCommand(o: { execPath: string; bridgeJs: string; pipe: string; dataDir: string; ask: string | null }):
  { command: string; args: string[]; env: Record<string, string> } {
  const env: Record<string, string> = { ELECTRON_RUN_AS_NODE: '1', LOLPING_PIPE: o.pipe, LOLPING_DATA: o.dataDir };
  if (o.ask !== null) env.LOLPING_ASK = o.ask;
  return { command: o.execPath, args: [o.bridgeJs], env };
}

/** The `mcpServers` JSON an agent that reads its own MCP file needs, to paste once; no ask, so it works for any run. */
export function userConfigSnippet(o: { execPath: string; bridgeJs: string; pipe: string; dataDir: string }): string {
  return mcpServersJson(bridgeCommand({ ...o, ask: null }));
}

/** Electron's userData folder for lolPing, found without Electron because the bridge runs as plain Node. */
export function dataDirFor(platform: Platform, env: NodeJS.ProcessEnv, home: string): string {
  if (platform === 'win') {
    return path.win32.join(env.APPDATA || path.win32.join(home, 'AppData', 'Roaming'), pkg.productName);
  }
  if (platform === 'mac') return path.posix.join(home, 'Library', 'Application Support', pkg.productName);
  return path.posix.join(env.XDG_CONFIG_HOME || path.posix.join(home, '.config'), pkg.productName);
}

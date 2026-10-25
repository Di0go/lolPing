import { describe, expect, it } from 'vitest';
import { bridgeCommand, dataDirFor, userConfigSnippet } from '../../../src/main/mcp/bridgeCommand';

const ASK = `ask-7.${'0f'.repeat(16)}`;

describe('bridgeCommand', () => {
  const base = {
    execPath: 'C:\\lolPing\\lolPing.exe', bridgeJs: 'C:\\lolPing\\resources\\app.asar\\out\\main\\bridge.js',
    pipe: 'P', dataDir: 'D',
  };

  it('runs the app executable as Node on bridge.js', () => {
    const c = bridgeCommand({ ...base, ask: null });
    expect(c.command).toBe(base.execPath);
    expect(c.args).toEqual([base.bridgeJs]);
    expect(c.env).toEqual({ ELECTRON_RUN_AS_NODE: '1', LOLPING_PIPE: 'P', LOLPING_DATA: 'D' });
  });

  it('adds LOLPING_ASK when there is an ask, and no secret-looking names', () => {
    const c = bridgeCommand({ ...base, ask: ASK });
    expect(c.env.LOLPING_ASK).toBe(ASK);
    for (const name of Object.keys(c.env)) expect(name).not.toMatch(/KEY|TOKEN|SECRET|PASSWORD/);
  });
});

describe('userConfigSnippet', () => {
  it('is the mcpServers JSON for the bridge, without an ask', () => {
    const o = { execPath: 'C:\\lolPing\\lolPing.exe', bridgeJs: 'C:\\lolPing\\bridge.js', pipe: 'P', dataDir: 'D' };
    expect(JSON.parse(userConfigSnippet(o))).toEqual({
      mcpServers: {
        lolping: {
          command: o.execPath, args: [o.bridgeJs],
          env: { ELECTRON_RUN_AS_NODE: '1', LOLPING_PIPE: 'P', LOLPING_DATA: 'D' },
        },
      },
    });
  });
});

describe('dataDirFor', () => {
  it('finds the userData folder of the lolPing app on each platform', () => {
    expect(dataDirFor('win', { APPDATA: 'C:\\Users\\a\\AppData\\Roaming' }, 'C:\\Users\\a'))
      .toBe('C:\\Users\\a\\AppData\\Roaming\\lolPing');
    expect(dataDirFor('mac', {}, '/Users/a')).toBe('/Users/a/Library/Application Support/lolPing');
    expect(dataDirFor('linux', { XDG_CONFIG_HOME: '/x' }, '/home/a')).toBe('/x/lolPing');
    expect(dataDirFor('linux', {}, '/home/a')).toBe('/home/a/.config/lolPing');
  });
});

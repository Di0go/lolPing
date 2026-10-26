import { describe, expect, it } from 'vitest';
import { x11RelaunchArgs } from '../../src/main/ozone';

const wayland = { WAYLAND_DISPLAY: 'wayland-1', DISPLAY: ':0' };

describe('x11RelaunchArgs', () => {
  it('starts again under XWayland, keeping the original arguments, in a Wayland session', () => {
    expect(x11RelaunchArgs(['/opt/lolPing/lolping', '--hidden'], wayland)).toEqual(['--hidden', '--ozone-platform=x11']);
  });

  it('keeps the app path of a development run', () => {
    expect(x11RelaunchArgs(['/repo/node_modules/electron/dist/electron', '.'], wayland)).toEqual(['.', '--ozone-platform=x11']);
  });

  it('does not relaunch a start that already has the switch, so it never loops', () => {
    expect(x11RelaunchArgs(['/opt/lolPing/lolping', '--hidden', '--ozone-platform=x11'], wayland)).toBeNull();
  });

  it('leaves a platform the user chose on the command line alone', () => {
    expect(x11RelaunchArgs(['/opt/lolPing/lolping', '--ozone-platform=wayland'], wayland)).toBeNull();
  });

  it('does not relaunch on an X11 desktop or in a Wayland session without XWayland', () => {
    expect(x11RelaunchArgs(['/opt/lolPing/lolping'], { DISPLAY: ':0' })).toBeNull();
    expect(x11RelaunchArgs(['/opt/lolPing/lolping'], { WAYLAND_DISPLAY: 'wayland-1' })).toBeNull();
  });
});

# Linux (experimental: X11, and KDE Plasma 6 on Wayland)

This source tree adds a Linux backend to lolPing 0.5.1. It is a local development port; upstream releases may not contain Linux packages yet.

## Requirements

- x86-64 Linux; development and package validation use Ubuntu 24.04.
- A genuine **X11 desktop session**, with a compositor for transparent overlays, or **KDE Plasma 6 on Wayland** with the KWin plugin below. Running the X11 helper through XWayland inside a Wayland session is insufficient: it cannot see or hold back input meant for native Wayland applications.
- XInput 2.1, XTest, and the usual Electron desktop libraries. No root privileges or access to `/dev/input` are needed to run the input helper.
- GNOME needs its AppIndicator extension to display the tray. Ubuntu normally includes this extension. Other desktops need a system tray.

## Build

Install Node.js **22.12 or newer** and a C++20 compiler. On Ubuntu/Debian:

```sh
sudo apt-get install build-essential libx11-dev libxi-dev libxtst-dev
npm ci
npm run build:helper
npx install-electron
npm run dev
```

Build distributables on Linux:

```sh
npm run dist:linux
```

This produces `release/lolPing-<version>-x86_64.AppImage`, `release/lolPing-<version>-amd64.deb`, and the unpacked application in `release/linux-unpacked/`.

```sh
# Debian / Ubuntu installation
sudo apt install ./release/lolPing-0.5.1-amd64.deb

# Portable build (requires FUSE support and Electron sandbox support on the host)
chmod +x release/lolPing-0.5.1-x86_64.AppImage
./release/lolPing-0.5.1-x86_64.AppImage
```

On Ubuntu versions that restrict unprivileged user namespaces, prefer the installed `.deb` if the portable build reports a Chromium sandbox error. Do not change global security settings to run it. If only FUSE is missing, AppImage's `--appimage-extract-and-run` can be used instead.

## KDE Plasma 6 on Wayland

A Wayland client cannot see or hold back another client's input, so on Wayland the gesture decision (`decision.cpp`, the same code the other platforms use) runs inside KWin as a binary compositor plugin, `native/kwin-plugin/lolping.cpp`. It sits in KWin's input chain after the lock screen and before global shortcuts and window actions, swallows only wheel gestures, replays short trigger clicks, and speaks the helper's JSON-lines protocol over `$XDG_RUNTIME_DIR/lolping-kwin-<WAYLAND_DISPLAY>.sock`. The hook helper detects Wayland, asks KWin to load the plugin (`org.kde.KWin.Plugins.LoadPlugin`) and relays lines between the app and that socket. With no app connected the plugin passes every event; it has no timers while no gesture is open. When the connection drops (KWin restarted, the plugin reloaded) the helper keeps running and tries again every second, asking KWin to load the plugin each time; the plugin's `ready` on the new connection makes the app send its settings again.

- Build: `native/kwin-plugin/build.sh` (needs the `kwin` headers, which Arch ships in the `kwin` package, and Qt 6). Install `build/lolping.so` into `/usr/lib/qt6/plugins/kwin/plugins/`.
- KWin refuses a binary plugin built for another KWin version (it logs "mismatching plugin version" and keeps running), so **rebuild the plugin after every KWin update**. Until then the app reports that input is unavailable, and on KDE Wayland it also shows a desktop notification with the command that rebuilds it.
- A KWin that has refused the plugin, or already loaded it, keeps that answer until it exits: a rebuilt plugin loads at the next login, not before (tried in a nested KWin, also with the new build under another file name).
- The overlay still runs through XWayland. Electron chooses between Wayland and X11 before the main script runs, so a start inside a Wayland session relaunches itself once with `--ozone-platform=x11` (`src/main/ozone.ts`). KWin does not let an XWayland window's always-on-top hint win against Wayland windows, so on KDE Wayland the app adds a window rule (`lolping-overlay` in `kwinrulesrc`, visible in System Settings → Window Rules) that forces the overlay into KWin's overlay layer, over full-screen windows too.
- KWin itself binds Alt + drag (move window). While lolPing is on, its trigger wins; paused, KWin's binding works again. AltGr (a custom key trigger) is free of desktop bindings.
- Gesture positions are KWin logical pixels. They match the overlay at a desktop scale of 100%; other scales are untested.
- Arch Linux: `packaging/arch/build.sh` builds the helper, the plugin and the app, then a package with a menu entry. The package also ships the plugin's sources and `/usr/lib/lolping/rebuild-kwin-plugin`, which a pacman hook runs after every KWin update: a compile of about 7 seconds with the system compiler, no npm and no network. If it fails, the app's notification gives the same command to run by hand.
- `native/hook-helper/tests/evdev_tests.cpp` checks the plugin's key map against the system's XKB keycode names. The plugin's input path was tested in a headless nested KWin (`kwin_wayland --virtual`) with libei input.

## Behavior and limits

- Alt + left drag opens the ping wheel; Ctrl + left drag opens emotes. Ctrl + Alt + P pauses/resumes. Side buttons and custom keyboard triggers are supported. Escape and right click cancel an active wheel.
- A custom keyboard trigger still types when tapped: its key is held back and typed when it comes up, unless a drag used it. Pressing another key while it is held types it first.
- A short trigger + click is replayed to the underlying application unless click-to-ping is enabled. Normal clicks are replayed by the X server itself.
- Window managers may already own a chord, particularly Alt + drag or Super. The helper logs conflicting grabs. Choose a different trigger, such as Ctrl, Shift or a side button, or change the conflicting desktop shortcut.
- Caps Lock is not offered: passive X11 grabs cannot reliably prevent its lock state from changing. Automatic fullscreen-game detection is Windows-only; pause manually before games.
- Linux forces Electron to a scale factor of 1, matching X11 root coordinates. This keeps overlay placement consistent across monitors, but the settings window does not follow desktop HiDPI scaling.
- Autostart uses `$XDG_CONFIG_HOME/autostart/lolPing.desktop` (normally `~/.config/autostart/`). AppImages use the original AppImage path rather than their temporary mount. Move the AppImage before enabling autostart.
- Settings are in `$XDG_CONFIG_HOME/lolPing/settings.json` (normally `~/.config/lolPing/settings.json`).
- Updates are manual for this port. It never calls the Windows installer updater or offers an upstream package for another platform.
- Room networking, assets, audio and renderer behavior use the existing shared implementation. Public relay availability is independent of Linux support.

## Validation

```sh
sudo apt-get install xvfb
npm run typecheck
npm run test:helper
npm test
npm run test:linux-input
npm run dist:linux
```

`test:linux-input` starts its own private Xvfb display, creates a receiving application window, and sends XTest input through the actual helper. It checks ordinary click delivery, short-click replay, modifier-first release, both wheels, custom/side-button triggers, cancellation, toggle/pause, key-capture suspension, cleanup and unsupported sessions. It never injects input into the user's desktop. `XVFB` can override the Xvfb binary path.

The Linux CI job builds both packages and uploads them as workflow artifacts. Release publication is unchanged; this port does not publish packages automatically.

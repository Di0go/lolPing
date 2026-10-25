# lolPing for macOS — Design Spec

**Date:** 2026-10-02
**Status:** Implemented in v0.2.0 (experimental). v0.2.1 fixes a frozen cursor during gestures, found in the first test on a real Mac

## 1. Purpose and constraints

Bring lolPing to macOS with the same behaviour as on Windows: hold a key, drag, release on a slice, and the ping appears on any display and in whole-screen capture.

| Topic | Decision |
|---|---|
| Hardware | Apple Silicon (arm64) only |
| Minimum OS | macOS 13 (Ventura), required by Electron 44 |
| Testing | No Mac available to the developer. CI on an Apple Silicon runner builds, unit-tests and packages it. A friend tries the published release. |
| Signing | Ad-hoc (`codesign -s -`), no Apple Developer account, no notarization |
| Codebase | One codebase. Developed on the `mac` branch, merged into `main`, released together with Windows as v0.2.0 |
| Default trigger | ⌥ Option + drag. Toggle ⌃⌥P. |
| Trigger choices | Option, Control, Shift, Command, Mouse 4, Mouse 5, custom key. Caps Lock is not offered (macOS can't reliably suppress its toggle). |
| Settings look | Mac-native restyle of the same React/Fluent components (see `prototype/settings-demo-mac.html`) |

## 2. Hook helper

The helper stays one C++ program. `decision.cpp`, `commands`, `json`, `output`, `simulate` are shared. Only the OS layer differs:

| File | Platform |
|---|---|
| `hooks_win.cpp`, `main_win.cpp` | Windows (unchanged logic, renamed) |
| `hooks_mac.cpp`, `main_posix.cpp` | macOS |
| `macinput.{h,cpp}` | Pure logic used by `hooks_mac.cpp`, no Apple headers, so it is unit-tested on both platforms |

`build.sh` compiles with `clang++ -std=c++20 -arch arm64` and links CoreGraphics, CoreFoundation and ApplicationServices.

### 2.1 Event tap

- A `CGEventTap` (session level, head insert, active) on its own thread with a `CFRunLoop`. The main thread reads stdin and forwards commands to the tap thread's run loop.
- **Swallow:** the callback returns `NULL`. **Replay:** a new down + up posted with `CGEventPost`, for buttons and for a tapped custom trigger key (with the current modifier flags; modifier keys are never posted, their real flag change passes). Our own events carry `kSelfMarker` in `kCGEventSourceUserData` and are ignored.
- **Watchdog:** a 1 s `CFRunLoopTimer`, same as the Windows `WM_TIMER`.
- **Tap disabled** (`kCGEventTapDisabledByTimeout` / `ByUserInput`): re-enable it and resync key state.
- **stdin EOF or `shutdown`:** stop the run loop, remove the tap, exit.

### 2.2 Keys

- `macinput` maps macOS key codes to the Windows virtual-key codes used everywhere else (letters, digits, F1–F20, arrows, navigation keys, punctuation, keypad). Settings, protocol and the UI keep using VKs.
- Modifiers arrive as `kCGEventFlagsChanged`. The device-dependent flag bits tell left from right, and `macinput::modifierTransitions(oldFlags, newFlags)` turns a flag change into VK key-downs and key-ups: Option → `VK_LMENU`/`VK_RMENU`, Control → `VK_LCONTROL`/`VK_RCONTROL`, Shift → `VK_LSHIFT`/`VK_RSHIFT`, Command → `VK_LWIN`/`VK_RWIN`. So the Win bit in `toggleMods` means Command on Mac.
- A double tap of the ask key (Command on the Mac) is plain key-down and key-up logic in `Decision`, fed by those flag transitions. Nothing is swallowed on macOS, so the second tap needs no mask key.
- **Secure Event Input** (password fields) hides keyboard events from taps. Every mouse event also carries the modifier flags, so the helper runs `modifierTransitions` on them too before handing the mouse event to `Decision`. Option + drag keeps working.
- The Alt/Win "mask key" injection is Windows-only; the Mac layer drops `kMaskVk` injections.

### 2.3 Mouse

- Coordinates are `CGEventGetLocation`: global points with the origin at the top-left of the main display. That is Electron's DIP space, so the helper sends points, not pixels.
- `LeftMouseDragged`/`RightMouseDragged`/`OtherMouseDragged` are fed to `Decision` as moves and always pass through, like moves on Windows. Swallowing them during a gesture froze the cursor on a real Mac. The app underneath does receive drags whose press it never saw, which apps ignore.
- Mouse 4/5 are `OtherMouseDown` with button numbers 3 and 4.
- `ScrollWheel` is in the tap's mask and fed to `Decision` as a scroll at the event's location. It is never swallowed. It is reported only while the teammate's stale watch is on, at most one per 100 ms.

### 2.4 Permission

Creating an active tap needs Accessibility. If `CGEventTapCreate` returns `NULL`, the helper prints `{"type":"error","code":"noAccess","message":…}` and exits with code **3**.

## 3. Electron main process

- **Platform:** `src/shared/platform.ts` (`'win' | 'mac'`), detected in main and passed to the settings page by its preload.
- **Helper path:** `hook-helper.exe` on Windows, `hook-helper` on Mac.
- **Coordinates:** on Mac each display map uses `phys = dip` and `scale = 1`, so `physicalToLocal` needs no change and `screen.dipToScreenRect` (Windows-only) is never called.
- **Overlays:** `type: 'panel'`, `setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })`, hidden in Mission Control, level `screen-saver`, click-through.
- **App shell:** Dock icon hidden except while the settings window is open; a minimal application menu (app, Edit, Window) so ⌘Q, ⌘W and clipboard shortcuts work.
- **Menu bar icon:** a template image (`build/trayTemplate.png`, `@2x`). Off = half alpha. Failed or no access = a non-template orange icon. A click opens the menu, which includes Settings….
- **Startup:** start in the menu bar with a toast pointing at the menu bar icon. The settings window opens on first run (no settings file yet), when Accessibility is missing, and on `activate`/`second-instance`. Open at login uses `setLoginItemSettings({ openAtLogin })`.
- **Accessibility flow:**
  - `HelperStatus` gains `'noAccess'`.
  - Before starting the helper, main calls `systemPreferences.isTrustedAccessibilityClient(false)`. If false: status `noAccess`, helper not started, poll every 1.5 s, start the helper once trusted.
  - The settings card's button calls `isTrustedAccessibilityClient(true)` (adds lolPing to the list and shows the system prompt) and opens `x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility`.
  - `InputBridge` treats exit code 3 as `noAccess`: no restart, no crash count. If macOS says lolPing is trusted but the tap still fails (a stale entry after an ad-hoc update), the card tells the user to remove lolPing from the list with "–" and turn it on again, with a Try again button.

## 4. Settings UI

- `<html data-platform="mac">`. A Fluent theme made with `createLightTheme`/`createDarkTheme` from macOS-blue brand ramps, the system font and Mac radii.
- `mac.css`, scoped to `[data-platform="mac"]`: translucent sidebar on `vibrancy: 'sidebar'`, 52 px drag bar leaving room for the traffic lights (`titleBarStyle: 'hiddenInset'`), grouped inset rows with separators and no per-row icons, iOS-style green switches without On/Off text, Mac keycaps.
- The Dock animation warps the page's last frame, where the sidebar is transparent (the vibrancy sits behind the page). While the window is minimized, the main process inserts a plain sidebar fill and keeps the renderer painting; on restore it removes the fill and rebuilds the vibrancy.
- `PermissionCard` appears at the top while the status is `noAccess`.
- `triggerLabel`, `hotkeyParts`, `hotkeyLabel` take the platform: Mac shows ⌥ Option / ⌃ Control / ⇧ Shift / ⌘ Command and hotkeys as `⌃⌥P`.
- `strings(lang, platform)` overlays Mac wording in English and Chinese (Open at login, Follow macOS, menu bar instead of tray, Mac limitations, "Add ⌃, ⌥ or ⌘").
- Key capture rejects Caps Lock on Mac, including the custom-key and shortcut paths. `normalizeSettings(raw, platform)` repairs both named and custom Caps Lock triggers to Option (ping) or Control (emote).
- The teammate's ask key is the `win` trigger (⌘). `hooks_mac.cpp` turns menu-key masking off, so ⌘ is never masked.
- The Teammate section shows a Screen Recording card while `getMediaAccessStatus('screen')` is not `granted`. It is read again when the window regains focus. The card opens the Screen Recording pane of System Settings.
- `context-helper` grabs the display with ScreenCaptureKit on macOS 14+ and with `CGWindowListCreateImageFromArray` (lolPing's own windows left out) on macOS 13. Both grabs share one 2.6 s deadline, inside the 3 s request timeout. Without Screen Recording the reply is the `permission` error.
- `context-helper` reads text on screen with `context_text_mac.mm`. The boxes around the element under each spot, controls and text near the spots, the selection, the focused field, the text under each spot, the browser address and the file behind the window come from the Accessibility API, so they need Accessibility for `context-helper` too; without it those replies are the `permission` error. Every AX call uses the same 0.5 s messaging timeout, and walks of an app's element tree stop at 0.8 s with what they have. The timeout is set on the system-wide element before any probes start; this changes the default for the whole helper process, so concurrent probes must not pick their own timeout. See [Apple's timeout contract](https://developer.apple.com/documentation/applicationservices/1459345-axuielementsetmessagingtimeout).
- A password field's value is never read: the focused element, or one of its three parents, with role or subrole `AXSecureTextField` gives `focusSecure` and no value, and text from an element that has such a field anywhere below it (or whose tree is too big to check in time) is dropped.
- The teammate's overview and close-up are framed in points from the Accessibility boxes around the spot. On a Retina display a close-up has twice the pixels, so one longer than 1600 pixels is scaled down to that. Without boxes the close-up is 1000 x 750 pixels of the capture, 500 x 375 points.
- The teammate's actions run in `context_write_mac.mm`, which does what `context_write_win.cpp` does. The form fields come from the Accessibility tree under the first spot: the page's `AXWebArea` in a browser, else the window. Text fields, text areas, combo boxes, pop-up buttons, check boxes and radio buttons are listed in document order. A label is the `AXTitleUIElement`, `AXTitle`, `AXDescription` or `AXPlaceholderValue`, and a field with the `AXSecureTextField` subrole is secure.
- The Accessibility API has no runtime ids. Each fields read numbers its fields `<window>.<read>.<number>`, and the helper keeps the elements of the last four reads, so `setField` and a paste's click check find them again. The read generation starts from a random seed mixed with the process id, reducing collisions on quick restarts. A field not in the registry or belonging to another window is `gone`.
- The foreground reply's window id is the app's process id above the `CGWindowID` of its topmost normal-level window, in decimal. The window under a click point is named the same way, so a paste checks both with the same id. Paste and `setField` use the optional `frontWindowId` hook: NSWorkspace supplies the foreground process id and `CGWindowListCopyWindowInfo` supplies the window, without an AX query to the target. The regular foreground reply still reads the title through AX, and carries the frontmost app's pid so main can tell an ask made from its own card. Windows keeps its existing foreground fallback. No private API is used.
- The `front` command (the stale watch's poll) answers from the same window list: the frontmost app's topmost normal-level window, its `kCGWindowName` (empty without Screen Recording), its `kCGWindowBounds` in global points rounded to whole numbers, and the owner pid. It makes no Accessibility call.
- `setField` sets `AXValue` on text fields and reads it back, presses check boxes and radio buttons with `AXPress` until the state matches, and presses a pop-up's `AXMenuItem` by name. Check states accept both CFBoolean and CFNumber values. If an opened pop-up refuses the selection, `AXCancel` goes to its `AXMenu` child. Every call uses the shared AX timeout.
- A paste saves every type of every `NSPasteboard` item. If any listed restorable format cannot be read, the shared paste route closes the clipboard and answers `busy` before any write, click or key event on both platforms. macOS lists promise types, then refuses them before requesting any data from their owner. A denied or failed format read therefore leaves the original clipboard untouched. This does not add a paste-access permission API; permission prompts and whether macOS hides an entire type list still need a real Mac check.
- After a complete save, the paste writes the text with the `org.nspasteboard.TransientType` and `org.nspasteboard.ConcealedType` markers (clipboard managers skip it), sends marked Command+V events, and restores the saved items with the same markers after 1 s. Empty data is preserved as a valid format. A newer user copy still wins over the restore.
- Command+V looks up the key that produces `v` with Command held. On the main command-loop thread it tries `TISCopyCurrentKeyboardLayoutInputSource`, then `TISCopyCurrentASCIICapableKeyboardLayoutInputSource`, reading `kTISPropertyUnicodeKeyLayoutData` and scanning codes 0–127 with `UCKeyTranslate` and `cmdKey >> 8`. The copied sources stay owned until translation finishes; key 9 is the final fallback. Both events use the same resolved code, the Command flag and the self marker. The context helper links Carbon. See [Apple's key translation contract](https://developer.apple.com/documentation/coreservices/1390584-uckeytranslate).
- The frozen-app check reads `AXRole` on the app with a 0.2 s timeout of its own, set on that app element. Only `kAXErrorCannotComplete` is treated as a hung AX call; `NotImplemented`, `AttributeUnsupported` and `NoValue` are answers. A missing or terminated app still refuses. If the focused element returns exactly `NoValue`, the helper checks the focused app again and returns open `other` facts when it responds; other unreadable focus errors still fail closed. A click target is checked separately as before. Replace's focused-selection secure-field scan gets 400 ms inside the parent check's 800 ms budget.
- Hands off means no Shift, Control, Option, Command or mouse button down, by `CGEventSourceFlagsState` and `CGEventSourceButtonState`. macOS has no integrity level that drops input, so the helper never answers `elevated`.
- The undo key the teammate names in its toasts is ⌘Z on macOS (`MAC_MATE_UI` in `i18n.ts`).

## 5. Packaging, CI, release

- `npm run build:helper` / `test:helper` call `native/hook-helper/run.mjs`, which runs `build.cmd` or `build.sh`.
- `npm run dist` builds the Windows installer, `npm run dist:mac` the Mac `.dmg` (`lolPing-<version>-arm64.dmg`), ad-hoc signed with `identity: "-"` and `hardenedRuntime: false`, `LSUIElement` not set (the Dock is managed at runtime).
- `tools/make_icon.py` also writes `build/icon.png` (1024 px) and the tray templates.
- CI: a `macos-latest` job runs typecheck, helper tests, TypeScript tests and `dist:mac`, then `codesign --verify --deep --strict` on the app.
- Release: one job creates the GitHub release, then the Windows and Mac jobs upload their installers.

## 6. Known Mac limitations

- Unsigned: first launch needs System Settings → Privacy & Security → Open Anyway.
- Accessibility must be granted again after every update (ad-hoc signatures change with each build).
- Windows of apps running with elevated privileges and the login window can't be pinged over; some full-screen games draw above the overlay.
- Single-window screen sharing doesn't include the pings.

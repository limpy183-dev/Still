# Still 2.0: the Rust rewrite

[← Back to the overview](../README.md) · [Development](development.md)

Since version 2.0.0 the Windows app is written in Rust. It looks and behaves like the Electron app it replaces (1.2.0 and older): the screens are the same HTML, CSS and JavaScript, drawn by the WebView2 that ships with Windows 10 and 11, and everything under them (the window, tray, alerts, the guard service, the installer) is Rust. These notes record what moved where, what changed on purpose, and how it was checked.

## What got faster, and what did not

Measured on one PC (Windows 11, 125% display scaling, preview mode, warm profile, median of 5).

| | Electron (1.2.0) | Rust (2.0.0) | |
| --- | --- | --- | --- |
| Installer | 140 MB | **5 MB** | about 28x smaller |
| On disk | 322 MB | **9.8 MB** | 33x smaller |
| "Find apps" scan (183 apps found) | 9.9 to 31 s (PowerShell) | **1.9 s** | 5x to 16x faster, same results |
| Process that runs Still's own logic | 27.5 MB main process (Node) | **3 MB** | |
| Idle memory, whole app | 160 to 182 MB (4 processes) | 175 to 183 MB (7 processes) | about the same |
| Memory while Still sits in the tray | 160 to 182 MB (the window stays loaded) | **3 MB**, 1 process (the web engine is released after 90 s) | about 50x less; reopening takes about 0.5 s |
| Start-up to a rendered Focus screen | 0.31 s | 0.63 s | **Rust is slower here** |

The screens still run in Chromium (inside WebView2 instead of Electron), so the memory they need (mostly the GPU process, about 105 MB in either) and how fast they draw are the same. WebView2 takes about 0.4 s to start, which is why first paint is about 0.3 s later than Electron's. What the rewrite removes is everything around the screens: the 280 MB runtime that had to be shipped and updated, the Node process, the slow PowerShell scans, and the C#/WPF pieces.


## Scope

Ported: the Still **Windows app**: the Electron main process, the C# Guard service and its native-messaging host, and the WPF installer/uninstaller.
Not ported (and not touched): the Android app, the website, and the browser extension's own code. The extension's files are bundled byte for byte from `app/browser-extension/` because the Windows app copies them to disk for "Set up browser companion", exactly as before.

## Where things went

| Original | Rust |
| --- | --- |
| `app/domain.cjs`, `websites.js`, `alert-domain.cjs`, `native/Session.cs` | `crates/still-core` (`domain`, `websites`, `alerts`, `session`) |
| `native/WindowsCompatibility.cs` | `still-core::compat` |
| `app/main.cjs`, `preload.cjs`, `guard-client.cjs` | `still-app` `app.rs`, `ui.rs`, `guard.rs` |
| `app/alerts-main.cjs`, `alarm-preload.cjs` | `still-app` `alerts.rs` (+ `ui.rs` for the alarm windows) |
| `app/websites-main.cjs` | `still-app` `websites.rs` |
| app discovery and icons in `main.cjs`, `native/discover.ps1` | `still-app` `discover.rs` (native), `apps.rs` (icons; runs the original script only as a fallback) |
| `native/Guard.cs`, `Websites.cs` | `still-guard` `guard.rs`, `enforce.rs`, `host.rs`, `service.rs`, `cli.rs` |
| `native/policy.ps1` | unchanged, in `native/` |
| `installer/Setup.cs`, `Setup.xaml` | `still-setup` `install.rs` + `crates/still-setup/ui/index.html` |
| `app/*.html/css/js` (screens) | unchanged in `app/`, embedded into `Still.exe` |

## How the screens still work

The screens expect Electron's `window.still` / `window.alarm` objects. `ui.rs` injects the same objects, backed by a small request/reply bridge to Rust, so the screens call the same functions with the same arguments and get the same results and the same error messages.
The page is served from the executable itself at `https://still.localhost/`; imported alarm media is served from `/media/<file>` with `Range` support, so audio and video seek.

## Lines changed in the original screens

Only the media address (the old `still-media://` scheme does not exist in WebView2): `app/alarm.js`, `app/alert-sound.js` and `app/alerts.js` use `/media/<file>`. Nothing else in the screens changed.

## Changes on purpose

- **Version 2.0.0.** The Rust build has to be newer than the Electron 1.2.0 it replaces: Setup compares versions to offer an update, and the original's "Check for updates" only offers a newer release. It is a major version because Still now needs the WebView2 runtime that comes with Windows 10 and 11 instead of bundling its own browser engine. Data, preferences and the guard protocol are unchanged. The browser companion keeps its own version (`app/browser-extension/manifest.json`, 1.2.0), as in the original.

- **The app scan is native.** `discover.ps1` took 10 to 30 s on this PC, most of it walking the Desktop folder recursively and querying Store packages. `discover.rs` reads the same places in the same order (Start menu and Desktop shortcuts, App Paths, running apps, Store packages), applies the same filters, and returns the same result: on this PC it finds the same 183 apps with the same names as the script (after the app's own protected-name filter). It takes 1.9 s. If it ever finds nothing, the original script runs instead.
- **Elevation is native.** Preparing protection asks Windows for administrator rights directly instead of starting a PowerShell to do it. Same prompt, same install steps.
- **Large selections reach the AppLocker script.** The original passed the selection on the command line, which overflows Windows' limit with many apps; the guard now hands it over in a file only SYSTEM and administrators can read. `policy.ps1` is unchanged.
- **Removing protection from the uninstaller waits for the guard.** The original script started the (GUI-subsystem) guard without waiting; the Rust one waits for its exit code before deleting folders.
- **The pipe is created first-instance-only** and the guard opens it only after loading its saved state.
- **One executable is both installer and uninstaller.** `Still-Setup-X.Y.Z.exe` is the setup program with the app appended; the `Uninstall Still.exe` it writes is the same program without the payload.
- **Sign-in item** is written under one name (`app.still.focus`) and the old Electron names are removed, so an update does not leave two entries.
- **"Something new" survives older versions.** Still 1.1.6 and older rewrite `preferences.json` with only the fields they know and drop `newThings`. The list is also kept in `new-things.json` beside it, and put back when `preferences.json` comes back without the field. `preferences.json` itself is unchanged, so Electron 1.2.0 reads it as before.
- **The web engine is released while Still is in the tray.** The window's browser processes (about 170 MB) are shut down 90 s after the window is hidden to the tray, leaving the 3 MB Rust process; opening Still again (tray, second launch, notification) starts a new engine and the same screen, which takes about 0.5 s. Saved data is untouched, but what was only on screen (the open page, text typed and not saved) starts over. Alarms start an engine of their own and ring about 0.1 s later. `STILL_ENGINE_RELEASE_SECS` changes the delay (`0` = never release); `--test` runs keep the engine unless it is set.
- **Test hooks** exist only under `--test`: file dialogs can answer from `test-pick.txt`, and the window report and resizing the original tests did through Electron. `STILL_SETUP_SANDBOX` redirects the installer into a folder for tests. None of this is active in normal runs.

## Data and compatibility

User data stays where it was and keeps its format: `%APPDATA%\still-focus\` (`preferences.json`, `alerts.json`, `alarm-focus.json`, `alert-media\`, `AlertSounds\`, `website-icons\`, `browser-companion\`) and `%ProgramData%\Still\state.json`.
The named pipe `Still.Focus.Guard.v1`, its JSON protocol, the service name `StillFocusGuard` and the native-messaging host name are unchanged, so an installed Electron app and a Rust Guard (or the other way round) keep talking.

## Verification

Run on the developer's PC (Windows 11, WebView2 156):

- `cargo test --workspace --release`: 55 unit tests: validation, alerts and DST handling, session rules, the guard protocol and its restart/recovery paths, browser-policy registry handling (in a throw-away registry key), the guard client's history cache and retry rules, native app scan, Windows helpers, installer helpers.
- The original Playwright tests `ui`, `todos`, `new-things`, `websites-ui` and `alerts-ui` pass against the Rust app, with only their launch lines changed. `alerts-ui` covers alarm cards, always-on-top and full-screen windows, imported image/video/audio, scheduled blocking while the window is hidden, snooze and overlap.
- Pixel comparison of the Focus screen, Electron against Rust: 0.03% of pixels differ (anti-aliasing and a 3 px taller Electron window). The installer's welcome screen was compared against the WPF original the same way and matches to within a few pixels of text position.
- The installer, installed, repaired, started and uninstalled in a sandbox folder (`tests/installer.cjs`); the real installation and registry were not touched.
- "Alarms after you quit": Windows Task Scheduler accepted the generated task, which fires 30 seconds before the next alert and is removed when the setting is turned off (`tests/wake.cjs`, test task name only).
- The tray icon is created, a second launch hands over to the first and exits, closing the window hides it to the tray while Still keeps running, and the page is told when it is hidden, shown and minimized (`tests/tray-window.cjs`).
- A real Windows toast notification was shown and dismissed through the shortcut identity Still registers (`cargo test -p still-app --release toast_pipeline -- --ignored --nocapture`).

- Tray release (`tests/engine-release.cjs`, `tests/engine-release-alarm.cjs`): after hiding, the engine is gone and 3 MB is left; reopening shows the same Focus screen (3 cycles, about 0.5 s each, memory back to about 170 MB); an alert that comes due while the engine is released still rings, about 0.1 s later than with the engine kept.

- More of the original tests, ported: `accessibility` (every option at every text size and window size, alarm windows included), `icons` (183/183 icons on this PC), `startup`, `optimizations`, `website-host` (the native-messaging host, against the Rust guard with its folders redirected) and `portability` (the dist copied to `…O'Brien & 100% [Ł李]…` with a Windows-only PATH). `website-setup` is a unit test (`companion_setup_refresh_and_extension_check`) because the original stubbed the registry; it writes only a throw-away key.
- Checked by hand against the original side by side: the tray menu (Open Still, Quit), double-clicking the tray icon, dragging the title bar, double-clicking it to maximize and back, resizing by the edges, the rounded corners and shadow of the main and alarm windows, and where windows open (to the pixel for the alarm card).

- **Live Windows protection (2026-10-28, on this PC, with the owner's approval):** `scripts/Test-WindowsProtection.ps1 -RunLiveTest` passed against the Rust guard installed as the real `StillFocusGuard` service: a running blocked app was closed; direct, renamed, command-line and shortcut launches were denied by AppLocker; early release was refused during the waiting period; the service was killed mid-session and Windows restarted it with the session kept and the app still blocked; the session expired on time, the app ran again, and the session was saved in the history. The script then put the previously installed C# guard back (same files, service running, earlier history untouched). It leaves its one-minute "Windows protection smoke test" session in the history, like the original's test (removed afterwards here through the guard's own delete request).

- **On a real installation (2026-10-30, with the owner's approval):** Still 2.0.0 installed over an Electron 1.2.0 installation with a real history (34 sessions, 42 to-dos, 23 "Something new" entries, 2 alerts with imported media, 6 alarm sounds): every file and setting came through unchanged, and the full test set above passed against the installed app. A live session blocked a test app (direct and renamed launches denied) and released it on time; a live website session showed Still's block screen in Chrome and removed every browser policy it had added at the end; and a real Windows restart in the middle of a 10-minute session brought back the guard with the session, opened Still at sign-in, kept the app blocked, and ended the session on time. The test sessions were then deleted from the history.

## Found and fixed by comparing with the original

Things the tests could not see, because they come from library defaults rather than from Still's code:

- **Tray icon:** the tray library opened the menu on a left click. Like Electron's tray, it now opens on right-click only, and a double-click opens Still.
- **Keyboard shortcuts:** the original never replaced Electron's default menu, so its shortcuts worked even without a visible menu: Ctrl+W (hide to the tray, or close an alarm), Ctrl+M (minimize), F11 (full screen), Ctrl+R and Ctrl+Shift+R (reload), Ctrl+Shift+I (DevTools), Ctrl+Plus / Ctrl+- / Ctrl+0 (zoom by half a level). They are mapped the same way, after the page has had its turn, as Electron did. WebView2 can open DevTools but not close it, so the second Ctrl+Shift+I does nothing; close DevTools with its own window.
- **Spelling:** Electron ran the screens with `spellcheck: false`; WebView2 underlined misspelled words in text fields. It is off now.
- **Autofill:** WebView2 would suggest earlier entries in forms (alert titles, website addresses); Electron never did. It is off now.
- **Window position:** frameless windows were placed by their invisible resize border, 8 px right of where Electron puts them. They are now placed by their content, like Electron (main window within 1 px, alarm card to the pixel).
- **Quitting just before an alert (test runs):** Still reopens itself when it quits inside the last 30 s before an alert. In a `--test` run it reopened without the test profile, so it would have started the real one; it now passes the profile along, as the original did. Found by porting the original's live `alerts-wake` check, which now passes: Windows reopened Still for the alarm after it quit, and Still reopened itself when quit inside the last 30 s.
- **Window after the tray release:** a window the user had moved, resized or maximized came back centered at its default size once the web engine had been released. It now comes back where it was (except after leaving it in F11 full screen, which comes back centered).

Left different on purpose:

- **Full-screen alarms really are full screen.** In the original, Electron cannot make a non-resizable window full screen, so a "full screen" alarm covered the work area only: the taskbar stayed visible and the page ran about 18 px past the right edge. The original's own test asserts that the window is full screen, so the Rust app does what was intended.
- **The window menu:** Alt+Space and a right-click on the title bar open the same window menu as the original. Only the strip at the very top that resizes the window is 9 px tall instead of 7 px (WebView2 decides that inside its own window), so a right-click in those 2 px resizes rather than opening the menu.
- **A few pixels of window size.** Chromium sizes frameless windows slightly larger than asked (here: the main window 2 px taller, the alarm card 5 px wider and taller). That depends on the display scale in ways that can't be reproduced reliably, so the Rust windows have exactly the requested size.
- **Start-up** is about 0.15 s slower (0.45 s against 0.3 s to the first rendered screen on this PC). WebView2 takes about 0.3 s to start its browser processes; serving the page's files straight from disk instead of from the app saved only 14 ms, and Chromium flags made no difference. Only a native interface would close that gap, and it could not look exactly the same.

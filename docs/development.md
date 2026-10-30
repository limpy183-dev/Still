# Developing Still

[← Back to the overview](../README.md) · [User guide](user-guide.md) · [Website blocking](website-blocking.md) · [The Rust rewrite](rust-port.md)

Run these commands from the repository root on Windows. You need Rust (`rustup`, the stable MSVC toolchain) with the Visual Studio C++ build tools, and Node.js 22 with npm for the checks.

## Develop and verify

```powershell
cargo run -p still-app -- --demo   # interactive preview; NEVER blocks real apps (npm run demo)
cargo run -p still-app             # the real app, with your own data (npm start)
npm run build                      # dist\Still\ (the app), dist\Still-<version>-Windows.zip (portable) and dist\Still-Setup-<version>.exe
npm run build:extension            # release/Still-Extension-<version>.zip (browser companion for the Chrome Web Store / Edge Add-ons)
```

`npm run build` runs `scripts/build.ps1`: a release build of the workspace, then the app folder, the portable zip and the installer. The installer is `Still-Setup` with the app appended, and the `Uninstall Still.exe` it writes is the same program without the app. The executables link the C runtime statically, so they need no Visual C++ redistributable; the screens need the WebView2 runtime that comes with Windows 10 and 11. Regenerate the installer icon with `python scripts/assets.py`.

`npm run build:extension` packs `app/browser-extension/` plus `app/websites.js` for store upload, without the manifest `key` (the stores assign their own ID). Bump the companion's own `version` in its `manifest.json` for each upload. Once a store assigns the listing's ID, add it to `STORE_IDS` in `crates/still-app/src/websites.rs` so Still Guard accepts that extension; the native-host file is rewritten on every app start, so existing users pick it up after updating.

```powershell
npm install                 # Playwright, for the checks below (no browser download needed)
cargo test --workspace --release   # rules, alerts, guard protocol and recovery, app scan, Windows helpers, installer (npm run test:rust)
npm test                    # website rules and the browser companion, social preview
npm run test:policy         # read-only Windows policy generation/evaluation (after npm run build)
npm run test:ui             # the full focus flow in explicit preview mode
npm run test:accessibility  # settings accessibility options: text size, contrast (7:1), fonts, focus, layout at every size
npm run test:installer      # install, repair, start and uninstall, inside a sandbox folder
npm run test:portability    # dist\Still copied to a Unicode / special-character path with a Windows-only PATH
```

The Playwright checks start `Still.exe` in preview mode with a temporary profile and drive its screens over WebView2's DevTools port. They use the debug build (`target\debug\Still.exe`) unless `STILL_PROFILE=release` or `STILL_EXE=<path>` says otherwise. More checks: `todos`, `new-things`, `websites-ui`, `alerts-ui`, `icons`, `startup`, `optimizations`, `shortcuts`, `tray-window`, `wake`, `alerts-wake` (live: Windows reopens Still for an alarm, about 3 minutes), `engine-release` and `engine-release-alarm` (the web engine is released in the tray and comes back), `website-host` (the native-messaging host) and `website-browser` (the companion in Playwright's Chromium, `npx playwright install chromium` once).

The policy test uses the built app and a renamed copy as harmless fixtures. It checks deny/allow decisions using Windows' actual AppLocker evaluator, checks a Store package when available, and asserts the PC's local policy is unchanged. It does **not** install rules or prove kernel enforcement.

The UI test covers selection, search, saved groups, setup, active-session immutability, rejecting early release, cancellation, window reload, reduced motion, compact layout, natural timer expiry, and session history. Screenshots are saved to `test-results/`.

**Live protection:** `scripts/Test-WindowsProtection.ps1 -RunLiveTest` (elevated Windows PowerShell, after `npm run build`) installs the built guard as the `StillFocusGuard` service and blocks only a generated harmless executable for one minute: launch denial, the service being killed and restarted mid-session, expiry and release. If a Still Guard is already installed it is set aside and put back at the end. Add `-Website` to also check browser blocking (Chrome or Edge open with the Still companion connected). It leaves its one-minute session in the history. Don't run it unless you mean to. Version 2.0.0 passed it, a live website session and a real restart during a session; see [the Rust rewrite](rust-port.md#verification).

## Source map

- `crates/still-core/`: validation, website rules, alert scheduling and session rules, shared by the app and the guard.
- `crates/still-app/`: `Still.exe`: window and tray, the bridge the screens call, alerts, app scan, website setup, the guard client.
- `crates/still-guard/`: `Still.Guard.exe`: the protected SYSTEM service, IPC, installation, recovery, persistence, and the browser companion's native-messaging host.
- `crates/still-setup/`: Still Setup (install, update, uninstall) and its screen.
- `app/`: the screens (HTML, CSS, JavaScript), embedded into `Still.exe`, and `app/browser-extension/`, the browser companion.
- `native/policy.ps1`: generation, verification, application, and removal of AppLocker rules (run by the guard).
- `native/discover.ps1`: read-only desktop and Store app discovery, used only if the native scan finds nothing.
- `installer/`: the installer's fonts, icon and manifest.
- `tests/`: website-rule unit tests, policy tests, and Playwright checks of the app and installer.
- `android/`: the Android preview app. See [Still for Android](android.md).
- `docs/`: user and developer guides, website setup, and README screenshots.

## Refreshing README screenshots

Run `npm run test:ui`, `npm run test:todos`, `npm run test:new`, and `node tests/websites-ui.cjs` on Windows. These checks use isolated demo data and never block real apps or websites. Inspect the resulting images in `test-results/`, then copy `focus-space.png`, `active-session.png`, `todos.png`, and `website-limits.png` into `docs/images/`. Keep the preview banner visible so screenshots are clearly identified as demo mode. The progress shot (`progress.png`, in both `docs/images/` and `website/assets/screens/`) comes from `node tests/progress-screenshot.cjs`, which shows a month of sample sessions in demo mode without saving them.

The Android screenshots (`docs/images/android-*.png`, some copied to `website/assets/screens/`) come from the `Still_Pixel` emulator with the debug build and sample data. Back up the app's `files/` and `shared_prefs/` with `adb exec-out run-as io.github.limpy183dev.still tar -cf - files shared_prefs`, write sample `todos.xml`, `prefs.xml`, `limits.xml` and `files/state.json` in the same way, use Android's status-bar demo mode (`sysui_demo_allowed`), capture with `adb exec-out screencap -p`, resize to 540 px wide, then restore the backup. `android-attention.png` uses the same month of sample sessions as `tests/progress-screenshot.cjs`, with Progress set to 30 days.

## Releasing

Bump the version in `Cargo.toml`, the `.rc` and `.manifest` files under `crates/`, and `package.json` (the Android build reads it), commit, then push a matching tag (`git tag v2.0.1 && git push origin v2.0.1`). The Release workflow tests and builds on Windows and publishes the installer and the Android preview as the latest GitHub release.

References: [AppLocker requirements](https://learn.microsoft.com/en-us/windows/security/application-security/application-control/app-control-for-business/applocker/requirements-to-use-applocker), [allow and deny behavior](https://learn.microsoft.com/en-us/windows/security/application-security/application-control/app-control-for-business/applocker/understanding-applocker-allow-and-deny-actions-on-rules), [packaged apps](https://learn.microsoft.com/en-us/windows/security/application-security/application-control/app-control-for-business/applocker/manage-packaged-apps-with-applocker), [WebView2](https://learn.microsoft.com/en-us/microsoft-edge/webview2/).

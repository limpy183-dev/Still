# Developing Still

[← Back to the overview](../README.md) · [User guide](user-guide.md) · [Website blocking](website-blocking.md)

Run these commands from the repository root on Windows. Use Node.js 22 (the version used by the release workflow) and npm.

## Develop and verify

```powershell
npm install
npm run build:native
npm start
npm run build
npm run dist         # release/Still-Setup-<version>.exe (installer, updater and uninstaller)
npm run build:extension # release/Still-Extension-<version>.zip (browser companion for the Chrome Web Store / Edge Add-ons)
```

The native helper builds with the .NET Framework compiler already included with Windows; no .NET SDK download is required. `npm run build` produces the portable x64 executable in `release/`. `npm run dist` packs the app into the installer from `installer/` (a WPF program compiled with the same built-in compiler); regenerate its icon with `python scripts/assets.py`.

`npm run build:extension` packs `app/browser-extension/` plus `app/websites.js` for store upload, without the manifest `key` (the stores assign their own ID). Bump the companion's own `version` in its `manifest.json` for each upload. Once a store assigns the listing's ID, add it to `storeIds` in `app/websites-main.cjs` so Still Guard accepts that extension; the native-host file is rewritten on every app start, so existing users pick it up after updating.

```powershell
npm test             # IPC validation and preference bounds
npm run build:native # Compile guard + native deadline/state checks
npm run test:policy  # Read-only Windows policy generation/evaluation
npm run test:ui      # Full Electron flow in explicit preview mode
npm run test:packaged # Real app discovery and resource check after building
npm run demo         # Interactive preview; NEVER blocks real apps
```

The policy test uses a harmless compiled fixture and a renamed copy. It checks deny/allow decisions using Windows' actual AppLocker evaluator, checks a Store package when available, and asserts the PC's local policy is unchanged. It does **not** install rules or prove kernel enforcement.

The UI test covers selection, search, saved groups, setup, active-session immutability, rejecting early release, cancellation, window reload, reduced motion, compact layout, natural timer expiry, and session history. Screenshots are saved to `test-results/`.

**Validation status:** native and JavaScript checks, read-only AppLocker evaluation, and the preview UI workflow have been run. Live elevated service installation, actual kernel-enforced launch denial, and reboot recovery still require an administrator smoke test on a suitable Windows PC. Use `scripts/Test-WindowsProtection.ps1 -RunLiveTest` for the installation/launch/expiry smoke test; it only targets a temporary harmless test executable. Reboot recovery should additionally be verified manually with that fixture before relying on strict sessions.

## Source map

- `app/`: Electron main/preload, the interface, and boundary validation.
- `native/Guard.cs`: protected service, IPC, installation, recovery, and persistence.
- `native/Session.cs`: session rules and deadlines.
- `native/policy.ps1`: generation, verification, application, and removal of AppLocker rules.
- `native/discover.ps1`: read-only desktop and Store app discovery.
- `installer/`: Still Setup (install, update, uninstall) and its fonts/icon; built by `scripts/build-installer.ps1`.
- `tests/`: native, JavaScript, policy, and UI checks.
- `android/`: the Android preview app. See [Still for Android](android.md).
- `docs/`: user and developer guides, website setup, and README screenshots.

## Refreshing README screenshots

Run `npm run test:ui`, `npm run test:todos`, and `node tests/websites-ui.cjs` on Windows. These checks use isolated demo data and never block real apps or websites. Inspect the resulting images in `test-results/`, then copy `focus-space.png`, `active-session.png`, `todos.png`, and `website-limits.png` into `docs/images/`. Keep the preview banner visible so screenshots are clearly identified as demo mode.

During the September 24, 2026 documentation refresh, the to-do and website UI checks passed. The focus UI check produced the focus screenshots but timed out waiting for natural session expiry; that run does not establish a passing end-to-end focus workflow.

## Releasing

Bump `version` in `package.json`, commit, then push a matching tag (`git tag v1.1.0 && git push origin v1.1.0`). The Release workflow builds the installer on Windows and publishes it as the latest GitHub release.

References: [AppLocker requirements](https://learn.microsoft.com/en-us/windows/security/application-security/application-control/app-control-for-business/applocker/requirements-to-use-applocker), [allow and deny behavior](https://learn.microsoft.com/en-us/windows/security/application-security/application-control/app-control-for-business/applocker/understanding-applocker-allow-and-deny-actions-on-rules), [packaged apps](https://learn.microsoft.com/en-us/windows/security/application-security/application-control/app-control-for-business/applocker/manage-packaged-apps-with-applocker), [Electron security](https://www.electronjs.org/docs/latest/tutorial/security).

# Still: notes for agents

Still is a Windows 10/11 x64 focus app. It blocks apps (through AppLocker) and websites (through a Chrome/Edge companion), and it also has to-dos, alerts and session history. Repo: `limpy183-dev/Still`. Website: https://stillfocus.fyi/home

## The suite

| Part | Where | Notes |
| --- | --- | --- |
| Desktop app | `app/` | Electron (CommonJS `.cjs` main side, plain JS renderer). `main.cjs` is the entry point and `preload.cjs` is the IPC bridge. Feature modules are `alerts-*`, `websites-*` and `todos.js`. `domain.cjs` / `alert-domain.cjs` handle validation. |
| Browser companion | `app/browser-extension/` | MV3 extension that talks to the app over native messaging. The app copies it to disk on start and stamps `version_name` with the app version, and the companion reloads itself when that changes (see `websites-main.cjs`). Its own `manifest.json` `version` is separate from the app version. |
| Still Guard (native) | `native/` | C# SYSTEM service (`Guard.cs`), session rules (`Session.cs`), website helpers (`Websites.cs`) and Windows checks (`WindowsCompatibility.cs`). `policy.ps1` writes the AppLocker rules and `discover.ps1` finds installed apps. It is built with the .NET Framework compiler that ships with Windows (`npm run build:native`), so it needs no SDK. |
| Installer | `installer/` | WPF Setup (`Setup.cs`/`.xaml`) that installs, updates and uninstalls per user. `scripts/build-installer.ps1` builds it. |
| Android app (preview) | `android/` | Plain Java, Android framework only (no AndroidX/libraries). An accessibility service blocks apps and (via browser address bars) websites, enforces daily website limits and bedtime, shows block screens, and has the to-do list, session history and alerts (reminders, alarm screens, alert-started sessions with snooze); `Session.java` mirrors `native/Session.cs`, `Websites.java` mirrors `app/websites.js`, `Alerts.java` mirrors `app/alert-domain.cjs`; the rules are JVM unit-tested. The UI copies the desktop look (Manrope, the olive palette, `app/styles.css` animations) with a bottom bar between the five pages (`Nav.java`). Build/test: `cd android && ./gradlew testDebugUnitTest assembleDebug`. See `docs/android.md`. A signed preview APK (`Still-Android-preview-X.Y.Z.apk`) is attached to each GitHub release by `release.yml` (key in the `ANDROID_KEYSTORE`/`ANDROID_KEYSTORE_PASSWORD` secrets); the Download page (`#android`) links it, and `site.js` points that link at the latest release's APK. |
| Website | `website/` | Static HTML/CSS/JS with no build step. `.github/workflows/pages.yml` deploys it to GitHub Pages on every push to `main` that touches `website/**`. |
| Docs | `README.md`, `docs/` | User guide, website blocking, development, Windows compatibility. |
| Tests | `tests/` | `npm test` runs the `*.test.cjs` unit tests. There are also Playwright/Electron UI scripts (`test:ui`, `test:todos`, `test:alerts`, `test:websites`), PowerShell policy tests and C# native tests. See `docs/development.md`. |

## Keep in mind when changing things

- **Safety first.** A strict session is meant to be hard to escape, and a bug can lock users out of their own apps. Never weaken the checks that refuse managed/MDM/domain PCs or PCs with existing app-control policy. Never weaken the IPC sender validation either.
- **Use `npm run demo` or the test scripts** to try the UI. Preview mode never blocks anything. Don't run live protection (`scripts/Test-WindowsProtection.ps1 -RunLiveTest`) unless the user asks.
- **Validate at boundaries.** IPC input is checked in `domain.cjs`/`alert-domain.cjs` and again natively. If you add a field, add validation and a test on both sides.
- **User data must survive updates.** Preferences, alerts, to-dos and history persist across installs, so change storage formats in a backward-compatible way.
- **Paths may be unusual:** Unicode, apostrophes, `%`, `&`, brackets, redirected folders. See `docs/windows-compatibility.md` before touching file URLs, installer paths or PowerShell invocation.
- **Keep dependencies at zero** for the website and the runtime app (devDeps only: electron, electron-builder, playwright). Don't add npm packages casually.
- **Features touch several places.** A user-visible change usually means updating the app, the docs (`README.md`/`docs/user-guide.md`) and the website (`features.html`, `guide.html`, `faq.html`). Refresh the screenshots if the UI changed (see `docs/development.md`).
- Run `npm test` before finishing. Run the relevant UI script if the UI changed.

## Releasing a new version

1. Bump `version` in `package.json` (and `package-lock.json`).
2. **GitHub release notes:** edit `.github/release-notes.md`. Replace the previous "What's new" section with a short "What's new in vX.Y.Z" section for this release only; keep the install instructions. The release workflow checks that the file has exactly one matching version section, passes it as the release body, and `--generate-notes` appends the commit list.
3. **Website changelog** (https://stillfocus.fyi/changelog, `website/changelog.html`):
   - Add a new `<article class="panel release latest" data-tag="vX.Y.Z">` at the top of `#releases`, with a date, a plain-language bullet list, and download/GitHub links in the same format as the existing entries.
   - Remove `latest`, the "Latest" pill and the primary download button from the previous entry.
4. **Website version everywhere:** update `FALLBACK` in `website/js/site.js` (version, date, size, url, sha256 of the new `Still-Setup-X.Y.Z.exe`). Also update the hardcoded `data-version` / `data-size` / `data-date` fallback text in every `website/*.html`, including the titlebar on every page and `404.html`. You can find them with `grep -rn "1\.0\.1" website` (swap in the old version). JS refreshes these from the GitHub API at runtime, but the static text has to be right for when it can't reach GitHub.
5. Commit, then `git tag vX.Y.Z && git push origin vX.Y.Z` (push the **tag only**; `main` is not pushed yet). `.github/workflows/release.yml` checks that the tag matches `package.json`, runs the tests, builds `Still-Setup-X.Y.Z.exe` and publishes it as the latest release.
6. Wait for that run to finish (`gh run watch`) and confirm `Still-Setup-X.Y.Z.exe` downloads. Then fill in the real date, size and sha256 in `site.js` and push `main`. **Don't push `main` before the release exists.** Pages deploys `website/**` on every push to `main` within a minute or so, but the release takes about 5 to 7 minutes to build. Pushing both together puts the new version's download links live while they still 404.

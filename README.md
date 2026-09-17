# Still

A local Windows productivity app: choose distracting apps and games, set a focus duration, and give yourself an optional waiting period before ending early.

## Run the Windows app

Open **`release/Still-1.0.0-Windows.exe`**. No Node.js or developer tools are needed for the packaged app.

1. Choose **Add applications**. Still discovers desktop apps, running windowed apps, and eligible installed Microsoft Store packages. You can also browse directly to one or more `.exe` files. Select a game's executable as well as its launcher.
2. Set a duration of **1–1,440 minutes** and, optionally, a release delay of **1–120 minutes**. Save app selections as reusable groups in the library.
3. Enable **Windows protection** once. The Windows administrator prompt installs Still Guard in Program Files and registers an automatic Windows service.
4. Save work in selected apps, then start the session. Selected running apps are closed. The selection, duration, and release delay cannot be changed during a session.
5. To end early, request release, wait the configured period, then choose **End focus session**. Waiting does not automatically end a session. Cancelling a release request restores the lock; a new request starts a new full wait. Natural session expiry always releases apps, even if a release wait would have lasted longer.

Closing the window hides it in the system tray. Quitting the UI does not stop the guard. Timers and release requests are persisted and survive restarting Windows. Session history, JSON export, completion notifications, reduced motion, and launch at sign-in are included.

Keep the portable executable in a stable location if you enable launch at sign-in. This is an unsigned local build; Windows may show a publisher prompt.

## To-do list

Open **To-do list** in the sidebar. Type `/` at the start of a line or after a space to choose a checkbox, tick circle, bullet, numbered item, heading, or note. Keep typing to filter; use the arrow keys and Enter or click a format. Escape dismisses the menu. Enter creates another line, and Backspace on an empty line removes it. Checkboxes and circles can be checked off independently.

The Windows app saves edits automatically with your local preferences, including during focus sessions. The list supports up to 500 lines of 2,000 characters each. Browser-only previews do not save edits. Run `npm run test:todos` to check formatting, editing, completion, and persistence.

## Protection and limits

The guard uses **Windows AppLocker**, not a foreground process-killing loop. Desktop selections receive exact path and file-hash deny rules. Where Windows exposes a sufficiently specific signed identity, publisher/product/binary rules also cover signed updates. Store selections use package publisher and product identity across versions. Rules target the Windows account that installed the guard. Already-running selected processes are closed only for that account.

This blocks ordinary process launches regardless of whether they originate from Explorer, a shortcut, a launcher, or a command line. File hashes also identify renamed, unchanged copies. Essential Windows components, Still itself, framework packages, and non-removable system packages cannot be selected.

**No app can guarantee an unbreakable lock against the administrator of the same PC.** An administrator can stop/remove the service, change policy or time, or use another account. Modified or differently identified desktop binaries, another operating system, remote games, and equivalent web services are not an absolute security boundary. Blocking a launcher alone does not identify every game it can launch; select those games too. The UI makes these limits visible.

Requires an updated Windows 10 version 2004+ or Windows 11, x64, Windows PowerShell 5.1, and .NET Framework 4.8 (normally included in current Windows installations). Older Windows 10 installations need the AppLocker edition-enforcement updates. Domain-joined and detected MDM-managed PCs, and PCs with existing application-control rules, are intentionally refused to avoid changing organizational security policy.

Still adds explicit allow rules for unrelated executables and packages before adding its temporary deny rules; AppLocker otherwise defaults to denying unmatched applications. It verifies the effective policy before reporting a successful start. Cleanup removes only rules carrying Still's reserved name prefix and restores the prior collection mode when the collection has no other rules. Unrelated collections and concurrently added third-party rules are retained. A policy snapshot is stored before applying changes. Application Identity (`AppIDSvc`) is enabled for enforcement.

## Recovery and removal

Normally, finish a session and use **Settings → Remove protection service**. Reopening **Enable Windows protection** reconnects an existing stopped guard belonging to the same account.

If the UI cannot connect, open Windows Services and check **Still Focus Guard**. If Windows refuses to release rules, the guard reports the error and retries. An administrator can use this emergency command in an **elevated PowerShell** window:

```powershell
& "$env:ProgramFiles\Still Guard\Still.Guard.exe" --recover
```

This deliberately overrides a session, stops and unregisters Still Guard, and removes Still's rules. It does not erase preferences/history or delete unrelated application-control rules. `--uninstall` refuses an unexpired session. If a service is being deleted, close Windows Services before reinstalling. A full disk or damaged Windows application-control components must be repaired before rule cleanup can succeed.

## Data and security

- No accounts, telemetry, cloud services, or network requests at runtime. The font is bundled locally.
- The Electron renderer is sandboxed, with context isolation, no Node integration, a restrictive Content Security Policy, blocked navigation, and allowlisted IPC methods with sender validation.
- The service runs as LocalSystem; its named pipe is restricted to its owner, SYSTEM, and administrators, with network access denied. Requests are bounded and validated again in the native service.
- Guard state is stored atomically in `%ProgramData%\Still\state.json`. Its directory and `%ProgramFiles%\Still Guard` are writable only by administrators and SYSTEM. The installing user receives read access.
- UI preferences are in Electron's `app.getPath('userData')` (normally `%APPDATA%\Still` in the packaged app). UI preferences do not control an active session. The guard retains up to 500 recent sessions, pruning older entries when the state reaches its 700,000-character budget.

## Develop and verify

```powershell
npm install
npm run build:native
npm start
npm run build
```

The native helper builds with the .NET Framework compiler already included with Windows; no .NET SDK download is required. `npm run build` produces the portable x64 executable in `release/`.

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
- `tests/`: native, JavaScript, policy, and UI checks.

References: [AppLocker requirements](https://learn.microsoft.com/en-us/windows/security/application-security/application-control/app-control-for-business/applocker/requirements-to-use-applocker), [allow and deny behavior](https://learn.microsoft.com/en-us/windows/security/application-security/application-control/app-control-for-business/applocker/understanding-applocker-allow-and-deny-actions-on-rules), [packaged apps](https://learn.microsoft.com/en-us/windows/security/application-security/application-control/app-control-for-business/applocker/manage-packaged-apps-with-applocker), [Electron security](https://www.electronjs.org/docs/latest/tutorial/security).

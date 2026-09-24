# Using Still

[← Back to the overview](../README.md) · [Website setup](website-blocking.md) · [Development](development.md)

Install, focus, schedule reminders, and manage Windows protection.

## Install

1. Download **`Still-Setup-<version>.exe`** from the [latest release](https://github.com/limpy183-dev/Still/releases/latest).
2. Run it and choose **Install Still**. It installs for your Windows account in `%LOCALAPPDATA%\Programs\Still`, adds a **Still Focus** Start menu shortcut (and optionally a desktop shortcut), and needs no administrator approval.
3. The build is not code-signed, so Windows SmartScreen may say it "protected your PC". Choose **More info → Run anyway**.

**Updating:** run the newer setup; it detects the installed version, closes Still for a moment, and replaces it while keeping your preferences, alerts, to-dos, and history. Settings → **Check for updates** tells you when a new version is out (it contacts GitHub only when you click it). Windows protection keeps running during updates. A browser companion you already set up is refreshed automatically: Still updates its files when it starts, and the companion reloads itself within a minute (blocking rules stay in place).

**Uninstalling:** Windows Settings → Apps → Installed apps → Still. You can choose to also remove Still Guard (administrator approval; not possible during an active focus session) and your data.

Already using the portable build? Just run the installer; your data carries over.

## Use the Windows app

1. Choose **Add applications**. Still discovers desktop apps, running windowed apps, and eligible installed Microsoft Store packages. You can also browse directly to one or more `.exe` files. Select a game's executable as well as its launcher.
2. Set a duration of **1–1,440 minutes** and, optionally, a release delay of **1–120 minutes**. Save app selections as reusable groups in the library.
3. Enable **Windows protection** once. The Windows administrator prompt installs Still Guard in Program Files and registers an automatic Windows service.
4. Save work in selected apps, then start the session. Selected running apps are closed. The selection, duration, and release delay cannot be changed during a session.
5. To end early, request release, wait the configured period, then choose **End focus session**. Waiting does not automatically end a session. Cancelling a release request restores the lock; a new request starts a new full wait. Natural session expiry always releases apps, even if a release wait would have lasted longer.

Closing the window hides it in the system tray. Quitting the UI does not stop the guard. Timers and release requests are persisted and survive restarting Windows. Session history, JSON export, completion notifications, reduced motion, and launch at sign-in are included.

Keep the portable executable in a stable location if you enable launch at sign-in. This is an unsigned local build; Windows may show a publisher prompt.
The packaged app creates a **Still Focus** Start Menu shortcut so Windows can identify its notifications; moving the portable executable updates that shortcut on the next launch.

## Website blocking

Chrome and Edge website selections, logos, custom block screens, redirects, and scheduled website blocks are supported. Set up the browser companion once in Settings. See [website setup, enforcement, and limits](website-blocking.md).

## To-do list

Open **To-do list** in the sidebar. Type `/` at the start of a line or after a space to choose a checkbox, tick circle, bullet, numbered item, heading, or note. Keep typing to filter; use the arrow keys and Enter or click a format. Escape dismisses the menu. Enter creates another line, and Backspace on an empty line removes it. Checkboxes and circles can be checked off independently.

The Windows app saves edits automatically with your local preferences, including during focus sessions. The list supports up to 500 lines of 2,000 characters each. Browser-only previews do not save edits. Run `npm run test:todos` to check formatting, editing, completion, and persistence.

## Alerts

Open **Alerts → New alert** to schedule a task once, daily, or on weekdays, starting on a chosen local date. Set a duration of 1–1,440 minutes or an end time; ranges can cross midnight. Each alert can use the current Focus space app selection, an independent selection (with **Copy current selection**), or no blocking.

Choose **Full attention** (all displays, above regular apps, with sound), **Focus card** (a smaller window above apps), or **Quiet reminder** (a dismissible Windows notification). Four built-in sounds, silent reminders, volume control, and imported audio/video sound files are included. Full attention requires sound. Full-screen and card alarms support images, GIFs, and muted video banners. Files are copied locally, up to 200 MB each; codec support varies, so MP3/WAV and H.264 MP4 are recommended. Preview and Listen never block apps.

Alerts run while Still is open or in the tray; quitting Still stops scheduling. Enable launch at sign-in to resume after restarting Windows. Sleeping PCs are not woken. On resume, only a still-active focus window is delivered; expired one-time reminders are marked missed. Recurring alarms use local wall-clock time, including daylight-saving changes, and already-delivered occurrences are not replayed after a clock rollback.

Saving or enabling an alert with app blocking checks Windows protection and installs/updates it if needed (Windows may ask for administrator approval). Existing alerts show a **Prepare / update app blocking** warning in the Alerts list if protection is not ready. Save your work: scheduled blocking closes selected running apps automatically. An existing focus session is never replaced; another alert waits and starts only if its window is still open. Its deadline stays fixed. Unavailable protection is reported in the alert list. The list highlights running alarms and snoozed reminders with their exact next alert time, and shows confirmed active blocking separately from selected apps. Snooze immediately releases the apps blocked by this alarm and blocks them again after five minutes, keeping the original end time; a reminder after the chosen end time does not restart or extend blocking; dismissal, pause, edits, and deletion do not release an active session. End sessions through Focus space as usual.

Alarm audio stops after one minute (six seconds for notifications), overlays dismiss after five minutes, and Escape dismisses an overlay when Dismiss is shown. Each alarm has a snooze limit (blank for unlimited, 0 to hide Snooze) and a Show/Hide Dismiss setting. The snooze count resets for each scheduled occurrence. Windows notification settings still apply. Secure Windows screens and some exclusive full-screen apps may appear above alarms. Schedules and delivery state are stored atomically in `alerts.json` alongside preferences; imported media lives in `alert-media/`. Run `npm run test:alerts` for the native preview/scheduler integration checks.

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

- No accounts or telemetry. The font is bundled locally. Website logos request only the selected domain from Google’s favicon service and are cached locally; offline sites use a letter icon.
- The Electron renderer is sandboxed, with context isolation, no Node integration, a restrictive Content Security Policy, blocked navigation, and allowlisted IPC methods with sender validation.
- The service runs as LocalSystem; its named pipe is restricted to its owner, SYSTEM, and administrators, with network access denied. Requests are bounded and validated again in the native service.
- Guard state is stored atomically in `%ProgramData%\Still\state.json`. Its directory and `%ProgramFiles%\Still Guard` are writable only by administrators and SYSTEM. The installing user receives read access.
- UI preferences are in Electron's `app.getPath('userData')` (`%APPDATA%\still-focus`). UI preferences do not control an active session. The guard retains up to 500 recent sessions, pruning older entries when the state reaches its 700,000-character budget.

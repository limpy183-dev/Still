# Still for Android (preview)

[← Back to the overview](../README.md) · [User guide](user-guide.md) · [Development](development.md)

A native Android version of Still's focus sessions, in [`android/`](../android). This is stage one: sessions, app blocking, a release delay, strict protection and the managed-phone check. Website blocking, to-dos, alerts and a history screen come later. There is no release build yet.

Android 11 or newer. It is written in plain Java against the Android framework, with no libraries, so the release APK is about 57 KB.

## How a session works

It follows the Windows rules: a 1–1,440 minute session, an optional 1–120 minute release delay, and 1–100 apps. To end early, request release, wait for the delay to pass, then choose **End focus session**. Cancelling a request means the next request waits the full delay again. When the session time runs out, apps are always released.

| Windows | Android |
| --- | --- |
| Still Guard + AppLocker deny launches | An accessibility service sees a blocked app's window, sends it to the home screen, and covers it until it's gone |
| Refuses domain/MDM PCs and PCs with existing app-control policy | Refuses work profiles and phones with a device or profile owner |
| Essential Windows components can't be selected | Still, the home screen, Settings, phone, dialer, emergency apps, keyboards, the package installer and the system UI can't be selected. The list is checked again at block time. |
| Session deadlines survive restarts | The same. Deadlines also ignore date/time changes (see below). |
| `Still.Guard.exe --recover` | `adb shell am broadcast -n io.github.limpy183dev.still/.Recover` (see Recovery) |

**Protect Still during the session** (strict, on by default): Settings and uninstall screens that mention **Still Focus** are sent home until the session ends. This covers Still's App info (Force stop, Uninstall), its accessibility page and the uninstall prompt. Settings pages that don't mention Still, such as Wi-Fi, keep working.

## Set up

1. Install the APK and open **Still Focus**.
2. Tap **Turn on app blocking** and switch on Still Focus under Accessibility. On Android 13+, for an APK not installed from a store, Android may say the setting is restricted. Open **App info → ⋮ → Allow restricted settings**, then try again.
3. Choose apps, a duration and an optional release delay, then tap **Start focus**. Allow notifications to see the countdown in the notification shade.

## Safety and recovery

- **Fail open.** If anything goes wrong while blocking, Still removes its cover rather than leaving the phone stuck. If the saved state can't be read, nothing is blocked, and the damaged file is kept as `state.corrupt.json`.
- **Atomic saves with a backup.** `state.json` is written through Android's `AtomicFile`, which keeps `state.json.bak` until a write completes and restores it after a crash or power loss.
- **Never locked out.** The cover only covers blocked windows, always has a **Go home** button, and never covers the home screen, phone or Settings pages that don't mention Still. System gestures always work.
- **Clock changes don't count.** Within one boot, deadlines use the uptime clock, so changing the date or time neither ends nor extends a session. After a reboot the wall clock is used again, capped at the session's own length.
- **Emergency release (USB debugging):** `adb shell am broadcast -n io.github.limpy183dev.still/.Recover` ends the session as *recovered* and keeps history. The receiver requires `android.permission.DUMP`, which only the system and the adb shell hold, so other apps can't send it.
- **Last resort: Safe mode.** Rebooting into Android's Safe mode switches off every downloaded app, including Still's blocking, without any help from Still.
- No cloud backup or phone-to-phone transfer (`allowBackup="false"` plus data extraction rules), so a running session is never restored onto another phone.

## Resource use

- **No session:** the accessibility service asks Android for no events at all, so it does no work. The process measured about 22 MB PSS and 0% CPU on a Pixel emulator.
- **During a session:** it receives only window changes (opening or switching apps), never content changes. It checks each change once, after an 80 ms settle. It re-checks every second only while a Settings screen is open in a strict session, and reads at most 400 items of that screen.
- The countdown in the notification is drawn by the system, so Still does no per-second work. There is one inexact alarm at the end time and no exact-alarm permission. Blocking checks the clock itself, so a late alarm never delays release.

## Limits

No app can make an unbreakable lock on a phone its owner controls. Safe mode, a factory reset, USB debugging or another user profile all get around Still, and these are deliberate ways back in. Picture-in-picture windows of a blocked app are covered where they are, not closed. Some phone makers' Settings apps may show Still's pages under a different app; report those as issues.

## Develop

```bash
cd android
./gradlew testDebugUnitTest assembleDebug
```

Gradle needs a JDK and the Android SDK (`ANDROID_HOME`). Android Studio's bundled JDK works (`JAVA_HOME="C:\Program Files\Android\Android Studio\jbr"`). The session rules in `Session.java` are plain Java and are unit-tested on the JVM (`src/test`).

| File | What it does |
| --- | --- |
| `Session.java` | Session rules and deadlines (mirrors `native/Session.cs`) |
| `Store.java` | Atomic state, history (500 entries), the end alarm and notifications |
| `BlockService.java` | The accessibility service that blocks apps and protects Still in strict sessions |
| `Device.java` | Protected apps, the managed-phone check, whether blocking is switched on |
| `MainActivity.java` | The one screen: set up a session, or watch and end the running one |
| `Events.java`, `Recover.java` | End alarm and date/time changes; emergency release |

Try it on an emulator with `adb install -r build/outputs/apk/debug/Still-debug.apk`. You can switch the service on without tapping through Settings:

```bash
adb shell settings put secure enabled_accessibility_services io.github.limpy183dev.still/.BlockService
```

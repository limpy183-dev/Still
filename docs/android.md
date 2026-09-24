# Still for Android (preview)

[← Back to the overview](../README.md) · [User guide](user-guide.md) · [Development](development.md)

A native Android version of Still's focus sessions, in [`android/`](../android). So far: sessions, app and website blocking, a release delay, strict protection, the managed-phone check, and daily website limits with bedtime. Custom block screens, to-dos, alerts and a history screen come later. There is no release build yet.

Android 11 or newer. It is written in plain Java against the Android framework, with no libraries, so the release APK is about 57 KB.

## How a session works

It follows the Windows rules: a 1–1,440 minute session, an optional 1–120 minute release delay, and 1–100 apps and websites together (website-only sessions work too). To end early, request release, wait for the delay to pass, then choose **End focus session**. Cancelling a request means the next request waits the full delay again. When the session time runs out, apps and websites are always released.

| Windows | Android |
| --- | --- |
| Still Guard + AppLocker deny launches | An accessibility service sees a blocked app's window, sends it to the home screen, and covers it until it's gone |
| Refuses domain/MDM PCs and PCs with existing app-control policy | Refuses work profiles and phones with a device or profile owner |
| Essential Windows components can't be selected | Still, the home screen, Settings, phone, dialer, emergency apps, keyboards, the package installer and the system UI can't be selected. The list is checked again at block time. |
| Chrome/Edge companion blocks websites | Reads the address bar of supported browsers and steps back from blocked websites (see below) |
| Session deadlines survive restarts | The same. Deadlines also ignore date/time changes (see below). |
| `Still.Guard.exe --recover` | `adb shell am broadcast -n io.github.limpy183dev.still/.Recover` (see Recovery) |

**Protect Still during the session** (strict, on by default): Settings and uninstall screens that mention **Still Focus** are sent home until the session ends. This covers Still's App info (Force stop, Uninstall), its accessibility page and the uninstall prompt. Settings pages that don't mention Still, such as Wi-Fi, keep working.

## Websites

Type a domain or paste a link under **Websites to block**. Links are reduced to their domain, and the whole domain and its subdomains are blocked: youtube.com also covers m.youtube.com, but not notyoutube.com. Still accepts and rejects the same input as the Windows app (no IP addresses, wildcards, credentials or local names).

During a session with websites, Still reads the address bar of **Chrome** (and Beta, Dev, Canary), **Edge**, **Brave**, **Vivaldi**, **Firefox**, **Samsung Internet** and **DuckDuckGo**. This includes links opened from other apps in those browsers' in-app tabs. When a blocked website is open, Still goes back a page and shows *"youtube.com is blocked until …"* over the tab until it has gone, with a **Go back** button. The browser stays usable for other websites, and nothing is blocked while you're typing in the address bar. Browsers Still can't read are blocked completely during sessions with websites, and are listed under **Blocked**, so they can't be used to get around it.

Why not a VPN or DNS filter? A local VPN would route every name lookup on the phone through Still, so any fault would break the whole internet. It would also take the phone's only VPN slot and could be skipped by Private DNS. Reading the address bar uses the service Still already runs, needs no new permission and fails open. The trade-off is that websites inside other apps' built-in web views aren't covered; block those apps instead. The Windows companion has the same scope: Chrome and Edge, not other apps.

## Daily limits and bedtime

Open **Time limits** from the main screen, during a session or not. They follow the Windows rules. Give any website a daily allowance of 0–1,440 minutes (0 means no daily limit) and choose whether it rests at bedtime. One bedtime window applies to every website with bedtime on. The default is 22:30–07:00 and it may cross midnight. YouTube, Instagram, TikTok, Reddit and X are offered as suggestions. The settings are saved in the same JSON shape as `websiteLimits` in the Windows preferences.

Time counts only while a limited website is the page in the browser window you're using, with the screen on. When the allowance is used up, or bedtime starts, the site is stepped back from and covered, like a session website: *"Today's time on youtube.com is used up. It's back after midnight."* or *"youtube.com is resting for bedtime until 7:00 AM."* Counts reset at local midnight. Bedtime and the daily count follow the phone's clock, so changing the date starts a new day, as on Windows. Limits work outside focus sessions and can be changed at any time, so they aren't protected by strict mode, matching Windows.

## Set up

1. Install the APK and open **Still Focus**.
2. Tap **Turn on app blocking** and switch on Still Focus under Accessibility. On Android 13+, for an APK not installed from a store, Android may say the setting is restricted. Open **App info → ⋮ → Allow restricted settings**, then try again.
3. Choose apps and websites, a duration and an optional release delay, then tap **Start focus**. Allow notifications to see the countdown in the notification shade.

## Safety and recovery

- **Fail open.** If anything goes wrong while blocking, Still removes its cover rather than leaving the phone stuck. If the saved state can't be read, nothing is blocked, and the damaged file is kept as `state.corrupt.json`.
- **Atomic saves with a backup.** `state.json` is written through Android's `AtomicFile`, which keeps `state.json.bak` until a write completes and restores it after a crash or power loss.
- **Never locked out.** The cover only covers blocked windows, always has a **Go home** button, and never covers the home screen, phone or Settings pages that don't mention Still. System gestures always work.
- **Clock changes don't count.** Within one boot, deadlines use the uptime clock, so changing the date or time neither ends nor extends a session. After a reboot the wall clock is used again, capped at the session's own length.
- **Emergency release (USB debugging):** `adb shell am broadcast -n io.github.limpy183dev.still/.Recover` ends the session as *recovered* and keeps history. The receiver requires `android.permission.DUMP`, which only the system and the adb shell hold, so other apps can't send it.
- **Last resort: Safe mode.** Rebooting into Android's Safe mode switches off every downloaded app, including Still's blocking, without any help from Still.
- No cloud backup or phone-to-phone transfer (`allowBackup="false"` plus data extraction rules), so a running session is never restored onto another phone.

## Resource use

- **No session and no limits:** the accessibility service asks Android for no events at all, so it does no work. The process measured about 22 MB PSS and 0% CPU on a Pixel emulator.
- **During a session:** it receives only window changes (opening or switching apps), never content changes. It checks each change once, after an 80 ms settle. It re-checks every 0.7 s only while a supported browser is on screen during a website session (one address-bar lookup, measured at about 0.3% of one core), or while a Settings screen is open in a strict session (at most 400 items read). With no browser or Settings screen open, a session measured 0 CPU ticks over 10 s. With limits set and no session, a supported browser is checked once a second. Nothing is checked or counted while the screen is off.
- Limit usage is kept in memory and saved at most every 30 seconds, and when you leave the site or the screen turns off, so counting adds no disk work to each check.
- The countdown in the notification is drawn by the system, so Still does no per-second work. There is one inexact alarm at the end time and no exact-alarm permission. Blocking checks the clock itself, so a late alarm never delays release.

## Limits

No app can make an unbreakable lock on a phone its owner controls. Safe mode, a factory reset, USB debugging or another user profile all get around Still, and these are deliberate ways back in. Picture-in-picture windows of a blocked app are covered where they are, not closed. Websites opened inside another app's built-in web view aren't seen. Browsers can rename their address-bar views in an update; the unit tests can't catch that, so check a browser update on a phone. Some phone makers' Settings apps may show Still's pages under a different app; report those as issues.

## Develop

```bash
cd android
./gradlew testDebugUnitTest assembleDebug
```

Gradle needs a JDK and the Android SDK (`ANDROID_HOME`). Android Studio's bundled JDK works (`JAVA_HOME="C:\Program Files\Android\Android Studio\jbr"`). The rules in `Session.java`, `Websites.java` and `Limits.java` are plain Java and are unit-tested on the JVM (`src/test`).

| File | What it does |
| --- | --- |
| `Session.java` | Session rules and deadlines (mirrors `native/Session.cs`) |
| `Websites.java` | Domain validation and matching (mirrors `app/websites.js`) and reading a host from an address bar |
| `Limits.java`, `LimitStore.java`, `LimitsActivity.java` | Limit and bedtime rules (mirrors `limits`/`inBedtime`/`limitBlocks`), their storage and today's usage, and the Time limits screen |
| `Store.java` | Atomic state, history (500 entries), the end alarm and notifications |
| `BlockService.java` | The accessibility service that blocks apps and websites and protects Still in strict sessions |
| `Device.java` | Protected apps, supported browsers, the managed-phone check, whether blocking is switched on |
| `MainActivity.java` | The one screen: set up a session, or watch and end the running one |
| `Events.java`, `Recover.java` | End alarm and date/time changes; emergency release |

Try it on an emulator with `adb install -r build/outputs/apk/debug/Still-debug.apk`. You can switch the service on without tapping through Settings:

```bash
adb shell settings put secure enabled_accessibility_services io.github.limpy183dev.still/.BlockService
```

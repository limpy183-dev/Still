# Website blocking: Chrome and Edge

[← Back to the overview](../README.md) · [User guide](user-guide.md) · [Development](development.md)

Website selections work everywhere application selections do: Focus space, the library, saved groups, alert-specific selections, current-selection alerts, and session history. Paste a URL or enter a domain in **Add website**. Paths are normalized to the domain; the whole domain and its subdomains are blocked. Up to 100 apps and websites may be selected together, including website-only sessions.

In **Settings → Website block screens**, choose Quiet garden, Evening calm, or A clean page; create a screen with your own headline, text, and JPG/PNG/WebP; or redirect blocked navigation to an HTTPS page. Images are resized once and kept below 180 KB encoded. Redirect destinations cannot be within a selected blocked domain. The chosen screen is copied into each session and cannot be changed during that session.

## Using the extension on its own

Still · Website focus from the Chrome Web Store or Edge Add-ons also works without the Windows app, including on Mac, Linux and ChromeOS. Click its toolbar icon to open its settings: add websites and start a focus session, add daily limits and bedtime, and choose a block screen (Garden, Dusk, Paper, your own message and image, or another page). These settings stay in that browser profile.

Without the app, a session can be ended at any time from the settings page, and the extension can be turned off from the extensions page. For sessions that can't be ended early, app blocking and the browser-policy fallback, set up Still for Windows as below.

**With both installed, they work together.** Each side keeps its own settings and only adds blocks: a site is held while either side's session holds it, and when both limit a site the stricter limit applies. Ending a session in the extension never releases the app's session, and the app's session ending never releases the extension's. The settings page shows what Still for Windows holds and which limits were set there. If a redirect page chosen on one side is held by the other, the block page is shown instead.

## Browser setup

1. Finish any active session. Choose **Settings → Set up browser companion**. This updates Still Guard, registers the browser's native messaging host, keeps a copy of the companion on this PC, and opens the extension in the Chrome Web Store.
2. Add [Still · Website focus](https://chromewebstore.google.com/detail/gkkjcgapilgkjafncmbkgcijnoijgejb) from the Chrome Web Store. Edge asks you to allow extensions from other stores first.
3. Open the Still extension's Details and enable **Allow in incognito** / **Allow in InPrivate**. The guard requires this capability before accepting the companion's readiness acknowledgement.
4. Repeat in every browser profile you use, then restart those browsers. The extension's tooltip should report connected and ready. Keep at least one connected browser open when starting a website session, including scheduled alerts.

While Settings is open, Still reads the extension list (`extensions.settings`) in each Chrome and Edge profile's `Preferences` / `Secure Preferences` on this PC. If neither the store extension nor the unpacked copy is added and enabled, **Set up browser companion** gently pulses and a note says so. It checks again when the window regains focus and every 10 seconds until the extension turns up, re-reading a file only when it has changed. Nothing is sent anywhere.

**Can't use the store?** Settings shows a **Load it from this PC instead** dropdown under the store steps. Open **chrome://extensions** or **edge://extensions**, enable Developer mode, select **Load unpacked**, and choose the folder shown there, then continue from step 3. Use the store version or the unpacked copy in each profile, not both.

Both the store extension and the unpacked copy can be removed from the browser like any extension; a force-installed (managed) extension would be needed for a stronger removal boundary, and Still does not claim that protection. The store version updates through the store. Still refreshes the unpacked copy's files when the app starts after an update, and the companion reloads itself within a minute while keeping its blocking rules. If it does not reconnect, reload it from the browser's extensions page.

## Daily limits and bedtime

In **Time limits** (in the sidebar under Your workspace), add any website (or one of five recommended: YouTube, Instagram, TikTok, Reddit, X), choose how long it gets each day, and switch bedtime on or off per website. One bedtime window (default 22:30–07:00) applies to every website with bedtime on. Limits live in Still's preferences; the companion's native host forwards them when they change, and the companion counts time while a limited website is open in any tab of any window, focused or not (checked every 30 seconds; several tabs of one site count once). When the time is used up, or bedtime starts, open tabs are sent to a block page and new visits are redirected until midnight or the end of bedtime. Limits work outside focus sessions and do not use the SYSTEM guard; they can be changed in Still at any time.

## Enforcement and recovery

The SYSTEM guard freezes the selected domains, screen, deadline, and release delay. Chrome/Edge declarative request rules redirect top-level visits and block matching subresources. Existing blocked tabs are redirected once when the rules change; cached/history navigation is covered too. A new website session is reported active only after a connected companion installs its rules, redirects existing tabs, and confirms private-window access. Without confirmation the start fails and rolls back. Domains are matched at label boundaries, so blocking youtube.com does not block notyoutube.com.

As a separate fallback the guard writes machine-level Chrome/Edge URLBlocklist policies and restricts guest/private browsing and extension-management pages. These temporary browser policies affect profiles across the PC. Existing allowlists or conflicting guest/private settings are refused, rather than overwritten. Still journals its own registry values before modifying them, and removes only unchanged Still-owned values on completion, release, snooze, failed start, startup recovery, or administrative recovery. Unrelated browser policies remain intact. Policy refresh is browser-controlled and can be delayed; the companion provides immediate enforcement.

Session state lives in the protected guard directory and survives quitting Still or restarting Windows. The companion retains its last confirmed rules if the native connection is lost, and releases only when the guard confirms release. Restart Windows protection if those rules remain after an outage. No TLS interception, root certificate, network proxy, DNS change, or background browsing-history upload is used.

This is a focus aid, not an absolute security boundary. Administrators, other browsers, alternative/proxy/remote websites, profiles without the companion before policy refresh, and removing the extension can bypass some controls. Supported-browser URL policies remain as a fallback after removal once they have refreshed. Web extensions cannot guarantee protection from the administrator of the same computer.

## Resource use and checks

Website filtering uses the browser's native rules. The native host waits on filesystem notifications; it does not repeatedly scan processes or tabs, poll URLs, or run a per-site timer. It transmits only changed website snapshots. Artwork is omitted from routine guard status and completed history. Logos are cached on disk and fetched with bounded response sizes/timeouts; initial icon hydration uses four concurrent requests.

Run `npm run build:native`, `npm test`, and `npm run test:websites`. The website checks cover domain validation, redirect loops, mixed/website-only selections, scheduled inheritance and snooze, isolated registry apply/cleanup/conflict handling, the UI and image import, real Chromium extension navigation, and the native messaging wire protocol. Browser testing uses an isolated temporary profile; set `STILL_TEST_BROWSER` to a Chromium-for-Testing executable if needed. The registry tests use a unique HKCU sandbox and never install live browser policies. Production policy enforcement still needs an administrator-approved smoke test on the target PC.

References: [Chrome URL policy matching](https://support.google.com/chrome/a/answer/9942583?hl=en), [declarative request rules](https://developer.chrome.com/docs/extensions/reference/api/declarativeNetRequest), and [Edge URLBlocklist](https://learn.microsoft.com/en-us/deployedge/microsoft-edge-browser-policies/urlblocklist).

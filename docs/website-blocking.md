# Website blocking: Chrome and Edge

[← Back to the overview](../README.md) · [User guide](user-guide.md) · [Development](development.md)

Website selections work everywhere application selections do: Focus space, the library, saved groups, alert-specific selections, current-selection alerts, and session history. Paste a URL or enter a domain in **Add website**. Paths are normalized to the domain; the whole domain and its subdomains are blocked. Up to 100 apps and websites may be selected together, including website-only sessions.

In **Settings → Website block screens**, choose Quiet garden, Evening calm, or A clean page; create a screen with your own headline, text, and JPG/PNG/WebP; or redirect blocked navigation to an HTTPS page. Images are resized once and kept below 180 KB encoded. Redirect destinations cannot be within a selected blocked domain. The chosen screen is copied into each session and cannot be changed during that session.

## Browser setup

1. Finish any active session. Choose **Settings → Set up browser companion**. This updates Still Guard, registers the browser's native messaging host, and opens a stable copy of the companion folder.
2. Open **chrome://extensions** or **edge://extensions**, enable Developer mode, select **Load unpacked**, and choose that folder.
3. Open the Still extension's Details and enable **Allow in incognito** / **Allow in InPrivate**. The guard requires this capability before accepting the companion's readiness acknowledgement.
4. Repeat in every browser profile you use, then restart those browsers. The extension's tooltip should report connected and ready. Keep at least one connected browser open when starting a website session, including scheduled alerts.

The local build uses an unpacked companion. A store-published, managed extension would be needed for a stronger installation/removal boundary; this build does not claim that protection. Still refreshes an existing companion's files when the app starts after an update, and the companion reloads itself within a minute while keeping its blocking rules. If it does not reconnect, reload it from the browser's extensions page.

## Daily limits and bedtime

In **Time limits** (in the sidebar under Your workspace), add any website (or one of five recommended: YouTube, Instagram, TikTok, Reddit, X), choose how long it gets each day, and switch bedtime on or off per website. One bedtime window (default 22:30–07:00) applies to every website with bedtime on. Limits live in Still's preferences; the companion's native host forwards them when they change, and the companion counts time while a limited website is the active tab of a focused browser window (30-second steps). When the time is used up, or bedtime starts, open tabs are sent to a block page and new visits are redirected until midnight or the end of bedtime. Limits work outside focus sessions and do not use the SYSTEM guard; they can be changed in Still at any time.

## Enforcement and recovery

The SYSTEM guard freezes the selected domains, screen, deadline, and release delay. Chrome/Edge declarative request rules redirect top-level visits and block matching subresources. Existing blocked tabs are redirected once when the rules change; cached/history navigation is covered too. A new website session is reported active only after a connected companion installs its rules, redirects existing tabs, and confirms private-window access. Without confirmation the start fails and rolls back. Domains are matched at label boundaries, so blocking youtube.com does not block notyoutube.com.

As a separate fallback the guard writes machine-level Chrome/Edge URLBlocklist policies and restricts guest/private browsing and extension-management pages. These temporary browser policies affect profiles across the PC. Existing allowlists or conflicting guest/private settings are refused, rather than overwritten. Still journals its own registry values before modifying them, and removes only unchanged Still-owned values on completion, release, snooze, failed start, startup recovery, or administrative recovery. Unrelated browser policies remain intact. Policy refresh is browser-controlled and can be delayed; the companion provides immediate enforcement.

Session state lives in the protected guard directory and survives quitting Still or restarting Windows. The companion retains its last confirmed rules if the native connection is lost, and releases only when the guard confirms release. Restart Windows protection if those rules remain after an outage. No TLS interception, root certificate, network proxy, DNS change, or background browsing-history upload is used.

This is a focus aid, not an absolute security boundary. Administrators, other browsers, alternative/proxy/remote websites, profiles without the companion before policy refresh, and development-extension removal can bypass some controls. Supported-browser URL policies remain as a fallback after removal once they have refreshed. Web extensions cannot guarantee protection from the administrator of the same computer.

## Resource use and checks

Website filtering uses the browser's native rules. The native host waits on filesystem notifications; it does not repeatedly scan processes or tabs, poll URLs, or run a per-site timer. It transmits only changed website snapshots. Artwork is omitted from routine guard status and completed history. Logos are cached on disk and fetched with bounded response sizes/timeouts; initial icon hydration uses four concurrent requests.

Run `npm run build:native`, `npm test`, and `npm run test:websites`. The website checks cover domain validation, redirect loops, mixed/website-only selections, scheduled inheritance and snooze, isolated registry apply/cleanup/conflict handling, the UI and image import, real Chromium extension navigation, and the native messaging wire protocol. Browser testing uses an isolated temporary profile; set `STILL_TEST_BROWSER` to a Chromium-for-Testing executable if needed. The registry tests use a unique HKCU sandbox and never install live browser policies. Production policy enforcement still needs an administrator-approved smoke test on the target PC.

References: [Chrome URL policy matching](https://support.google.com/chrome/a/answer/9942583?hl=en), [declarative request rules](https://developer.chrome.com/docs/extensions/reference/api/declarativeNetRequest), and [Edge URLBlocklist](https://learn.microsoft.com/en-us/deployedge/microsoft-edge-browser-policies/urlblocklist).

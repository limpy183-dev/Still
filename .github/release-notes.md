## What's new in v2.0.2

- **Kaspersky no longer deletes Still Guard's app-blocking script.** Kaspersky wrongly flagged `policy.ps1` (the script Still Guard uses to write the Windows app-blocking rules) as `HEUR:Trojan.PowerShell.Alien.gen` and deleted it, so app blocking stopped working. The script was restructured without changing what it does, and Kaspersky no longer flags it or the installer. If Kaspersky removed it on your PC, update, then start a focus session (or **Enable Windows protection**) once and approve the administrator prompt.
- **The focus countdown ticks evenly.** The timer now changes exactly once per second instead of sometimes lingering on a second and then skipping ahead.

## Install or update

Download **Still-Setup** below and run it. It installs Still for your Windows account (no administrator approval needed), or updates an existing installation (including Still 1.x) while keeping your preferences, alerts, to-dos and history.

Still isn't code-signed yet, so Windows SmartScreen may show "Windows protected your PC". Choose **More info → Run anyway**.

Requires Windows 10 version 2004+ or Windows 11 (x64).

**Browser extension:** get [Still · Website focus](https://chromewebstore.google.com/detail/gkkjcgapilgkjafncmbkgcijnoijgejb) from the Chrome Web Store for Chrome and Edge.

**Android preview (for testing):** `Still-Android-preview` is an early test build for Android 11+. It isn't a finished release yet. See [Still for Android](https://github.com/limpy183-dev/Still/blob/main/docs/android.md) for setup.

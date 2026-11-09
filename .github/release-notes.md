## What's new in v2.0.1

- **Windows protection works on new installs again.** On a PC that never had Still 1.x, Still 2.0.0 registered Still Guard with a broken program path, so Windows refused to start it: turning on protection or starting a focus session showed "IO error in winapi call", and the Still Focus Guard service stayed stopped ("Access is denied"). Updating repairs an existing setup: start a focus session (or **Enable Windows protection**) once and approve the administrator prompt.
- When Windows protection can't be set up, Still now shows the Windows error itself instead of "IO error in winapi call".

## Install or update

Download **Still-Setup** below and run it. It installs Still for your Windows account (no administrator approval needed), or updates an existing installation (including Still 1.x) while keeping your preferences, alerts, to-dos and history.

Still isn't code-signed yet, so Windows SmartScreen may show "Windows protected your PC". Choose **More info → Run anyway**.

Requires Windows 10 version 2004+ or Windows 11 (x64).

**Browser extension:** get [Still · Website focus](https://chromewebstore.google.com/detail/gkkjcgapilgkjafncmbkgcijnoijgejb) from the Chrome Web Store for Chrome and Edge.

**Android preview (for testing):** `Still-Android-preview` is an early test build for Android 11+. It isn't a finished release yet. See [Still for Android](https://github.com/limpy183-dev/Still/blob/main/docs/android.md) for setup.

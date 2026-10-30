# Windows compatibility audit

Still's installer and portable distribution include the app, the native guard, browser companion, fonts, icons and screens; the screens are drawn by the WebView2 runtime that comes with Windows. End users do not need Rust, Node.js, npm, Python, a .NET SDK, the Visual C++ redistributable, this source checkout, or the developer's Windows account. Each user discovers and selects applications installed on their own machine; developer preferences and media are not packaged.

## Supported configuration

| Configuration | Expected behavior and requirements |
| --- | --- |
| Windows 10, Intel/AMD x64 | Version 2004 or later with cumulative updates that include AppLocker edition support. Use fully updated Windows 10 22H2 where possible. Setup and protection installation check prerequisites. |
| Windows 11, Intel/AMD x64 | Supported with cumulative updates. Older 21H2/22H2 installations must update first. |
| Windows 10/11 Home and Pro | App blocking depends on the AppLocker updates described below. Home uses the SYSTEM service's CSP transport; other editions use local policy. Both need real enforcement testing on the target OS. |
| 32-bit Windows, Windows on ARM, macOS, Linux, Windows Server | Not supported release targets. This distribution is x64; ARM emulation is not certified. Source builds may run on Windows Server build agents, but Setup refuses Server as an end-user target. |
| Standard Windows account | App installation needs no elevation. Installing/updating/removing the protection service requires administrator credentials. The original user's SID is supplied before elevation. |
| Work/school managed PC or existing application-control policy | App blocking is intentionally refused to preserve organizational controls. Do not bypass these checks. |
| Multiple Windows accounts on one PC | App preferences are per-user; one guard owner is supported per PC. Another account cannot take over the installed guard. Browser fallback policies can affect all profiles on the PC during a session. |
| S mode, application allowlisting, restrictive antivirus | An unsigned desktop application can be prevented from running by Windows or administrator policy. Still cannot promise installation in those environments. |

Windows PowerShell 5.1, .NET Framework 4.8 and the Microsoft Edge WebView2 Runtime are Windows prerequisites. They are normally present on the supported releases; stripped-down images may need repair. The application itself installs offline. GitHub update checks and initial website-icon downloads need internet access; failed icon downloads fall back to initials. Browser setup needs a current Chrome or Edge installation and the companion in every relevant profile. Firefox and other browsers are outside this release's website coverage.

Microsoft's [AppLocker requirements](https://learn.microsoft.com/en-us/windows/security/application-security/application-control/app-control-for-business/applocker/requirements-to-use-applocker) and [KB5024351](https://support.microsoft.com/help/5024351) describe edition-independent enforcement. Setup conservatively requires Windows 10 servicing revision 2193+, Windows 11 build 22000 revision 1165+, or build 22621 revision 608+; newer Windows 11 builds include the change. These are cumulative OS build revisions, not a requirement that a standalone KB5024351 entry appear in update history. The [WebView2 runtime](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/distribution) is part of Windows 11 and is installed on current Windows 10; if it was removed, Still and Setup say so and point to Microsoft's download.

## Problems fixed during this audit

- **Non-English and unusual install paths (Electron app, 1.x):** Electron's file loader and Node's file-URL generator escaped percent signs and brackets differently. Literal URL comparison rejected the app's own IPC after relocation. Both main and alarm windows now load a correctly escaped file URL and compare decoded file paths while retaining sender/main-frame validation and rejecting other pages, queries and fragments.
- **Missing prerequisites:** Setup and Guard now share checks for Windows builds, required cumulative updates, .NET and PowerShell availability. Uninstallation remains available even if prerequisites later change.
- **Protection updates:** New policy eligibility is checked before an existing service is stopped or its files are replaced.
- **Uninstallation:** Encoded PowerShell commands preserve Unicode, apostrophes, percent signs and ampersands in paths. Folder removal is confined to the expected per-user installation, delayed cleanup waits for the uninstaller process, and uninstall errors are no longer discarded by an unconditional successful exit.
- **Other user sessions:** Setup only closes Still processes belonging to its installation and current Windows session.
- **Redirected Start menus:** Notification shortcut registration asks Windows for the actual Programs folder rather than assuming its location under AppData.
- **Display scaling:** The initial window fits the desktop's usable area, and its smaller minimum size allows the existing compact layouts to activate. Alarm cards remain inside small work areas. Setup scales down when its layout would exceed the available desktop.
- **Build paths:** XAML validation handles apostrophes in checkout paths. Setup embeds an explicit per-user execution manifest. The Node build requirement is recorded in package metadata.
- **Release checks:** Publishing now depends on JavaScript/native checks, a relocated packaged-app smoke test and actual compiled installer-helper tests.

## Feature audit and remaining limits

| Area | Finding |
| --- | --- |
| Installer/update | Per-user known folders and HKCU registration; complete application payload bundled. Updating replaces application files and retains data. Close a separate portable copy manually before switching to the installed copy. |
| Portable distribution | `Still-<version>-Windows.zip` carries the app and its guard files. Keep the executable at a stable location for sign-in launch. Copying just `Still.exe` out of the folder is not sufficient for protection, which needs the `guard` folder beside it; distribute the setup EXE, the zip or the entire folder. |
| Preferences, groups, to-dos, alerts and media | Per-user app-data storage. Imported media is copied locally. Moving another PC's saved app selections does not relocate the selected executables; reselect apps on the new PC. |
| Discovery and icons | Uses the current machine's shortcuts, registrations, Store packages and running apps. Missing artwork has fallbacks. Manual EXE selection remains available if discovery is restricted. |
| App protection | Protected machine-level service state and account-specific rules; process launch enforcement, recovery and reboot behavior require elevated OS-level validation. One owner per PC is a current design limit. |
| Website blocking and time limits | Companion files are extracted to a stable per-user directory. Native messaging is registered for Chrome/Edge. Current browsers and manual profile setup are required; policy refresh is browser-controlled. |
| Alerts and notifications | Local time-zone/DST logic, bundled sounds and local media. Alert scheduling needs Still running or in the tray. Sleep does not wake the PC. Windows notification permissions, Focus Assist/Do Not Disturb, codecs, audio devices and secure screens can change delivery. |
| Launch at sign-in | Uses the actual installed or portable executable path. Windows startup-app controls can override the setting. |
| Offline operation and updates | Core local features work offline. Update checks report network failures. No automatic install or dependency download occurs at end-user startup. |
| Signing | Release executables remain unsigned. SmartScreen/antivirus reputation prompts cannot be eliminated with a code change; trusted release signing requires a publisher certificate/signing service. |

## Verification

Automated checks are run on the available Windows 11 x64 machine. Version-boundary tests simulate Windows 10 inputs; they are **not** a Windows 10 VM run.

Completed in this audit (for the Electron app, 1.x): 38 JavaScript checks; 57 existing native session/protocol/website checks plus the new OS prerequisite cases; UI, to-do, browser extension, native messaging and read-only policy suites; compiled installer helper checks; the relocated packaged-app/browser-setup/alarm test; and an actual portable-launcher extraction/startup smoke test. Installer and portable executables were rebuilt locally. No release was published.

The same checks for the Rust app (2.0.0 and later):

```powershell
npm ci                         # build machine only: Node 22.12+ and npm, plus Rust (MSVC)
npm test
cargo test --workspace --release
npm run build                  # app folder, portable zip and installer in dist\
node tests/installer.cjs        # install, repair, start, uninstall in a sandbox folder
node tests/portability.cjs      # copied app, fresh data, unusual paths, Windows-only PATH
npm run test:ui
npm run test:todos
npm run test:websites
npm run test:policy             # read-only AppLocker evaluation
npm run test:csp                # in-memory CSP transport checks
```

The relocation test copies the built app, runs the focus and alarm checks against the copy in demo mode, and keeps its temporary data (including WebView2's) inside the unusual folder. Its directory includes spaces, an apostrophe, Unicode, percent signs, ampersands and brackets. It removes developer tools from the child's PATH and uses fresh temporary data. This reproduces path/runtime assumptions, not a separate Windows user or clean OS installation.

Before claiming tested support on Windows 10, run the following in clean Windows 10 22H2 Home and Pro x64 VMs and Windows 11 Home and Pro x64 VMs:

1. Download and install as a standard user, with no development tools; launch with networking disabled. Repeat under a Unicode account name and 125%/150% display scaling.
2. Enable Windows protection using administrator approval. Use the harmless fixture in `scripts/Test-WindowsProtection.ps1 -RunLiveTest` to verify actual launch denial and release; test Store applications as well.
3. Restart Windows during a fixture session and during a release delay; verify the deadlines, reconnection and eventual cleanup.
4. Install the companion in current Chrome and Edge, including additional profiles; verify website sessions, scheduled alerts, expiry and browser restart recovery.
5. Update, repair and uninstall; check preserved preferences, optional data removal, shortcuts, startup registration and service removal. Repeat with the browser native host running.

Live administrator/service installation, full installer/update/uninstall lifecycle and reboot testing are not performed by the automated read-only/demo checks. For 2.0.0, an update over 1.2.0 with real data, a live app session, a live website session in Chrome and a restart during a session were checked by hand on one Windows 11 Home PC ([details](rust-port.md#verification)); Store apps, Edge, extra browser profiles and Windows 10 were not. No guarantee is made that every Windows configuration behaves identically.

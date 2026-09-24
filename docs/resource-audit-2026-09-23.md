# Still and StillGuard resource audit

Date: 23 September 2026. Scope: the current working tree in `Ultimate_productivity_app`, including existing uncommitted alert changes. This is an analysis, not an implementation. Application sources, installed service, policies, and real preferences were not changed.

## Conclusion

Yes. There are behavior-preserving opportunities to reduce repeated CPU work, temporary allocations, and disk/registry work. The strongest targets are unnecessary UI rebuilds and repeated full-history transfer between StillGuard, Electron's main process, and the renderer. Savings in steady-state RAM are less certain: the measured Electron process group already has a substantial baseline with an empty history. A much smaller total footprint is unlikely to come from timer tweaks alone.

StillGuard's enforcement architecture is already economical: Windows AppLocker enforces the rules. The guard is not continually enumerating and killing processes. Its normal one-second tick checks a recovery file and session expiry. PowerShell is launched for policy transitions/recovery, not every tick. Preserve that architecture and its protection checks.

## Measurements and limits

The installed `StillFocusGuard` service was stopped and no Still process was initially running. I did not start the service, install protection, change AppLocker policy, or close selected apps. Consequently there is no measured live-service RAM or CPU baseline in this audit.

I launched current source using the installed Electron and Playwright with `--demo --test`, which uses separate temporary preferences and simulated protection. Three ten-second samples measured the four Electron processes (main, renderer, GPU, network utility). All test processes were closed afterwards.

| Sample | Sum of working sets | Sum of private bytes | Approximate whole-machine CPU |
| --- | ---: | ---: | ---: |
| Visible idle, no history or alerts | 410 MiB | 268 MiB | 1.81% |
| Window hidden, no history or alerts | 380 MiB | 237 MiB | 0.25% |
| Window hidden, 100 synthetic alert rows, after microbenchmarks | 464 MiB | 318 MiB | 0.50% |

These are diagnostic samples, not production guarantees or before/after optimization results. Private bytes are private committed memory, not exclusively resident RAM. Summing working sets can double-count shared pages. CPU was calculated from cumulative CPU-time deltas divided by elapsed time and 12 logical processors. The first sample includes settling after startup. The third follows allocation-heavy microbenchmarks, so its memory difference cannot be attributed entirely to retained alerts or called a leak.

**Instrumentation caveat:** Electron reported the window hidden, but the renderer reported `document.visibilityState === 'visible'` under automation. Ordinary packaged-app hidden-window throttling must be measured separately without the debugger before claiming background CPU savings. Main-process polling continues regardless of this caveat.

Observed DOM changes in each empty-state ten-second sample: five complete alerts-list replacements and fifteen timer-content replacements, despite no application-state change. The timer is updated by both its one-second timer and the two-second guard-status handler.

A synthetic 500-session history with one app per session and 100 alert rows gave these medians over 25 synchronous calls:

- Apply unchanged status: 10.6 ms.
- Rebuild alerts list: 10.2 ms.
- Render statistics with a 90-day range: 18.7 ms.
- The example full status response was 141,468 UTF-8 bytes. At one response per two seconds, that represents approximately 255 MB/hour of repeated pipe payload before renderer IPC copies. This is traffic/allocation churn, not retained memory growth. The synthetic response is representative of the data shape, not a byte-for-byte native-service capture.

Raw evidence: `test-results/resource-audit-2026-09-23.json`. Reproduction harness: `test-results/resource-audit.cjs`; run `node test-results/resource-audit.cjs` from the project root. These files are in the existing ignored test-results directory.

## Recommended changes, in order

### 1. Rebuild UI only when its inputs change

Evidence: `app/renderer.js:152-160` already compares a session/history signature but calls `renderAlerts()` unconditionally. `app/alerts.js:7-28` replaces the full alerts list, including rows, controls and formatted dates. `app/renderer.js:193-209` rewrites timer elements even when their displayed values are unchanged. `app/renderer.js:414` runs the timer every second and statistics every 30 seconds; `renderStats()` always calls the full progress-chart renderer at line 227. History rendering also calls statistics, duplicating work after some status changes.

Recommendation: retain the current update cadence for visible changing values, compare rendered values before DOM writes, and invalidate alerts only when alert data or relevant guard state changes. Calculate/render page-specific charts when their page is visible and refresh immediately when entered. Defer hidden-window presentation work, keeping authoritative state and main-process scheduling active, and refresh before the restored window is shown.

Benefit: strongest measured opportunity for reducing unnecessary renderer CPU and garbage collection. Preserve focus, keyboard interaction, accessibility updates, countdowns, and date/midnight rollover. Do not simply suppress status processing while hidden.

### 2. Stop retransmitting and reserializing unchanged history

Evidence: `native/Guard.cs:230-238` serializes the entire history for every successful request while holding the service lock; `app/main.cjs:265-275` polls and forwards status every two seconds. `app/renderer.js:157` then stringifies the entire history again just to detect changes. `native/Guard.cs:174-175` bounds history to 500 entries and a roughly 700,000-character state budget.

Recommendation: add an optional revision-aware status request. Continue delivering current time, session phase, release state and errors at the current cadence, but include history only when changed or explicitly requested. Keep the old response format for existing clients; use full snapshots on bootstrap, reconnect/service restart and export. Invalidate the revision for completion, archive, restore, delete and recovery. A service-instance identifier avoids stale-cache collisions after restart. Concurrent read-only status calls can share an in-flight request where doing so does not cross a mutation.

Benefit: reduces work in both Still and StillGuard, including allocations and time spent holding the guard lock. This is a coordinated protocol change that needs regression tests, not an unvalidated cache with a long expiry. It does not require discarding any history.

### 3. Avoid applying Windows login settings on unrelated saves

Evidence: `app/todos.js:85-88` saves on each keystroke. `app/renderer.js:70-73` snapshots and queues all preferences. `app/main.cjs:127-137` rewrites the preferences file and reapplies `setLoginItemSettings()` on every packaged-app save, even when launch-at-login is unchanged.

Recommendation: continue immediate persistence, but call the login-setting API only when its value or portable executable path needs updating, retaining appropriate startup reconciliation. Avoid unnecessary copies of unrelated preferences where practical.

Benefit: reduces registry/OS work during typing without weakening autosave. A simple delayed autosave/debounce is not strictly equivalent: it creates a new crash-loss window. Coalescing queued writes needs explicit flush and error-handling semantics before it can meet the behavior-preservation requirement.

### 4. Skip the hidden alarm renderer for silent Windows notifications

Evidence: `app/alerts-main.cjs:71-90` creates and loads an alarm BrowserWindow even for a quiet notification. `app/alert-sound.js:6` immediately returns for silent or zero-volume audio. The notification window is never shown, and `app/alarm.js:12` already suppresses its banner.

Recommendation: for notifications that require no audio, deliver the native notification without creating an alarm renderer. Keep existing queue order, click/open behavior, dismissal, ringing bookkeeping and ten-second presentation lifetime. Leave audible notification handling unchanged initially.

Benefit: avoids unnecessary transient window/render resources. Renderer-process reuse varies; a particular RAM saving is not yet measured. Full-screen multi-display alarms and audible notifications need their existing presentation/audio behavior.

### 5. Share appropriate status reads within scheduler work

Evidence: `app/alerts-main.cjs:153-205` requests guard status separately for each pending blocking alert, in addition to the main two-second poll. With many alerts waiting behind one active session, those requests repeatedly carry the same history.

Recommendation: after implementing compact status, reuse a fresh status result within a scheduler pass where safe; refresh after any start or other mutation and account for a session expiring during the pass. At minimum coalesce concurrent read-only requests without retaining stale state across writes.

Benefit: scales better with multiple waiting alerts. Preserve fixed deadlines, non-duplication of start requests, queue ordering and the existing two-second retry opportunities.

### 6. Reduce guard request allocation only if it remains material

Evidence: `native/Guard.cs:220` allocates a new 65,536-byte request buffer for each connection, including tiny status requests. The normal two-second poll alone therefore allocates approximately 112.5 MiB/hour in request arrays, before responses. This is allocation throughput, not a persistent memory leak.

Recommendation: start with a small buffer and grow only for larger requests, retaining the existing request-size limit and timeout. First optimize full-history responses, which can dominate. Avoid a permanent PowerShell host or extra service infrastructure for this small optimization.

## Changes that do not meet the constraint without further work

- Slower protection or scheduler polling can delay expiry, recovery, blocking or reminders. Keep the existing timing semantics.
- Disabling animation or audio changes presentation. Only suppress work while it cannot be seen/heard, restoring the correct state immediately.
- Destroying the main window when hidden could release more memory, but loses in-progress dialogs, edits, selection and scroll/focus state unless all are preserved. This is not the first optimization to implement.
- Reducing history limits or to-do limits changes supported behavior.
- Disabling GPU acceleration is not an established resource win and can move rendering load to the CPU.
- Forced garbage collection or working-set trimming does not remove the underlying work and may add pauses/page faults.
- Replacing Electron is a substantial rewrite with compatibility and behavior risks. The current source has no large production UI-framework dependency to remove as a quick win.

## Verification before shipping an optimized build

The existing JavaScript suite passed all 15 tests. The existing native session suite was compiled separately under test-results and passed all 17 checks. No application binaries were rebuilt or installed. These passes establish a baseline, not proof of an unimplemented optimization.

For implementation, compare the same packaged build and data sets before/after in visible, tray-hidden, idle, active-session, many-history, pending-alert and media-alarm scenarios. Capture sustained CPU, private commit, working set and transient peaks without debugger attachment. Verify visible timer behavior, release waits, natural expiry, alert/snooze deadlines, reconnects, history operations, crash-safe saves, and window restoration. Guard measurements require a separate live-service run; actual launch-denial checks should use the existing harmless-fixture workflow.

Recommended first batch: items 1, 2, 3 and the silent-notification case in item 4. These directly remove redundant work while preserving the current product. There is no defensible percentage RAM/CPU reduction to promise until that batch is implemented and compared.

Reference documentation: Electron's [performance guidance](https://www.electronjs.org/docs/latest/tutorial/performance), [memory metric definitions](https://www.electronjs.org/docs/latest/api/structures/memory-info), and [background throttling options](https://www.electronjs.org/docs/latest/api/structures/web-preferences).

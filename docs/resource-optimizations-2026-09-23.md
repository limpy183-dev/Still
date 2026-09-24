# Resource optimizations implemented

Implemented all six recommendations from `resource-audit-2026-09-23.md` in the existing working tree, including its alert fixes.

- Renderer: unchanged alert inputs retain their DOM; timer text changes only when its displayed value changes. Statistics are cached by their inputs and local day, progress charts render on their page, and hidden/minimized windows defer presentation while continuing to receive state. Reopening refreshes the existing document before showing it, preserving unfinished edits and dialogs.
- Guard history: optional revision tokens omit unchanged history, while live session/error/time fields keep their existing cadence. Tokens change on completion/recovery, archive/restore/delete, and service restart. Legacy requests still receive full history. Bootstrap and export request full snapshots; reconnects discard cached revisions. Polling IPC also omits unchanged history, with snapshot recovery if a renderer missed an update.
- Preferences: every save still writes immediately and atomically. Windows sign-in settings are reconciled at startup and updated only when their value or portable executable path changes.
- Silent notifications: native notifications with silent or zero-volume audio do not create an alarm window. Queue order, dismissal/click handling, ringing state, and ten-second lifetime remain. Audible notifications and other alarm windows retain their audio/presentation paths.
- Guard reads: simultaneous read-only requests share an in-flight read. Mutations invalidate the cache before and after execution, including uncertain failures. A scheduler pass can reuse an unexpired active session, with refresh after mutations, expiry, unavailable status, or no active session.
- Request buffers: Guard starts with 1 KiB and grows for larger requests, retaining the 65,536-byte request limit and existing read timeout.

Protection enforcement, timer/scheduler intervals, storage limits, release rules, audio, and animations are retained.

## Verification

`npm test` passes 22 JavaScript tests. `npm run build:native` passes 17 session checks and 14 protocol checks. Native protocol checks use temporary storage and do not run the service or alter Windows policy.

Source Electron checks pass for focus sessions, natural expiry, release waits/cancellation, reload persistence, to-do editing/autosave, alerts, snooze, overlapping scheduled blocking, media, full-screen/card previews, and compact layout. Read-only policy evaluation and the mocked CSP policy checks pass.

The packaged real-mode smoke test passes with 184 discovered Windows apps, selection/search, fonts, bundled resources, and the protection setup prompt. The packaged Guard matches the freshly compiled binary. Test profiles now include a timestamp so reused Windows process IDs cannot load an old test's preferences; normal user profiles are unchanged.

The actual portable executable was launched with isolated preview data and checked over its local debugging connection: extraction, app startup, optimized renderer, visible window, and IPC passed. Playwright's Electron launcher could not complete its normal attachment through the portable wrapper's stdout/stderr; the packaged application is tested directly via `release/win-unpacked/Still.exe` for the full automated workflows.

The optimization regression checks and full alert UI workflow also pass against that final packaged application.

`node tests/optimizations.cjs` checks unchanged DOM, compact history, hidden state processing, restored unfinished edits, release countdowns, and charts on page entry. Its ten-second idle sample recorded zero alert-list replacements and zero timer-content replacements (the original audit recorded five and fifteen). A synthetic 500-session snapshot measured 112,998 bytes full versus 96 bytes compact, with approximately 0.1 ms median unchanged-status processing. These are diagnostic workload measurements, not a total RAM/CPU reduction guarantee. Raw results are in `test-results/optimization-checks.json`.

The installed StillFocusGuard service was stopped. Live kernel launch denial, elevated installation, reboot recovery, and live service resource usage were not verified in this run. The existing live focus-start check could not reach its installed-service precondition. No installed protection or policy was changed by this work.

Build command: `npm run build`. Release path and name: `release/Still-1.0.0-Windows.exe`. The previous portable executable is retained at `test-results/pre-optimization-Still-1.0.0-Windows.exe`.

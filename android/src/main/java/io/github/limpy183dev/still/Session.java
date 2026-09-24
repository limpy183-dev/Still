package io.github.limpy183dev.still;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * A focus session, mirroring native/Session.cs. Pure Java so it is unit-tested on the JVM.
 *
 * Deadlines are tracked on two clocks. Within one boot the monotonic elapsed clock decides, so changing
 * the phone's date or time cannot end a session early or extend it. After a reboot the elapsed clock
 * restarts, so the wall-clock deadline is used and the elapsed anchor is re-established.
 */
final class Session {
    static final int MAX_MINUTES = 1440, MAX_DELAY = 120, MAX_APPS = 100, MAX_INTENTION = 120;

    /** One reading of both clocks. {@code boot} is Settings.Global.BOOT_COUNT (-1 if unavailable). */
    static final class Clock {
        final long wall, elapsed;
        final int boot;
        Clock(long wall, long elapsed, int boot) { this.wall = wall; this.elapsed = elapsed; this.boot = boot; }
    }

    String id, intention, outcome;
    long startedAt, endsAt, unlockAt, finishedAt;
    int durationMinutes, unlockDelayMinutes, boot;
    long endsElapsed, unlockElapsed;
    boolean strict;
    /** Package name to label, in selection order. */
    final Map<String, String> apps = new LinkedHashMap<>();

    static void validate(int minutes, int delay, int appCount) {
        if (minutes < 1 || minutes > MAX_MINUTES) throw new IllegalArgumentException("Choose a focus duration from 1 to 1,440 minutes.");
        if (delay < 0 || delay > MAX_DELAY) throw new IllegalArgumentException("Choose a release delay from 0 to 120 minutes.");
        if (appCount < 1 || appCount > MAX_APPS) throw new IllegalArgumentException("Select between 1 and 100 apps.");
    }

    static Session start(String id, String intention, int minutes, int delay, boolean strict, Map<String, String> apps, Clock now) {
        validate(minutes, delay, apps.size());
        Session s = new Session();
        s.id = id;
        String text = intention == null ? "" : intention.trim();
        s.intention = text.isEmpty() ? "Time to focus" : text.substring(0, Math.min(MAX_INTENTION, text.length()));
        s.durationMinutes = minutes;
        s.unlockDelayMinutes = delay;
        s.strict = strict;
        for (Map.Entry<String, String> app : apps.entrySet()) {
            String label = app.getValue() == null ? app.getKey() : app.getValue();
            s.apps.put(app.getKey(), label.substring(0, Math.min(100, label.length())));
        }
        s.startedAt = now.wall;
        s.boot = now.boot;
        s.endsAt = now.wall + minutes * 60000L;
        s.endsElapsed = now.elapsed + minutes * 60000L;
        return s;
    }

    private boolean sameBoot(Clock now) { return now.boot == boot && now.boot != -1; }

    // Capped at the chosen length, so moving the clock back before a reboot cannot stretch a session.
    long remaining(Clock now) {
        return Math.min(durationMinutes * 60000L, sameBoot(now) ? endsElapsed - now.elapsed : endsAt - now.wall);
    }

    boolean expired(Clock now) { return remaining(now) <= 0; }

    boolean unlockRequested() { return unlockAt != 0; }

    long unlockRemaining(Clock now) {
        if (!unlockRequested()) return Long.MAX_VALUE;
        return Math.min(unlockDelayMinutes * 60000L, sameBoot(now) ? unlockElapsed - now.elapsed : unlockAt - now.wall);
    }

    boolean canEnd(Clock now) { return unlockDelayMinutes == 0 || unlockRemaining(now) <= 0; }

    /** Starts the release wait. A pending request keeps its original time. */
    void requestUnlock(Clock now) {
        if (unlockRequested() || unlockDelayMinutes == 0) return;
        unlockAt = now.wall + unlockDelayMinutes * 60000L;
        unlockElapsed = now.elapsed + unlockDelayMinutes * 60000L;
    }

    void cancelUnlock() { unlockAt = 0; unlockElapsed = 0; }

    /**
     * Re-derives both deadlines from the clock that is trusted right now: the elapsed clock in the same
     * boot, the wall clock after a reboot. Returns true if anything changed and should be saved.
     */
    boolean anchor(Clock now) {
        long left = remaining(now), unlockLeft = unlockRemaining(now);
        long oldEnds = endsAt, oldUnlock = unlockAt;
        int oldBoot = boot;
        boot = now.boot;
        endsAt = now.wall + left;
        endsElapsed = now.elapsed + left;
        if (unlockRequested()) {
            unlockAt = now.wall + unlockLeft;
            unlockElapsed = now.elapsed + unlockLeft;
        }
        // The two clocks are read a moment apart, so ignore sub-second jitter to avoid pointless writes.
        return oldBoot != boot || Math.abs(endsAt - oldEnds) > 1000 || Math.abs(unlockAt - oldUnlock) > 1000;
    }
}

package io.github.limpy183dev.still;

import java.time.DayOfWeek;
import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalTime;
import java.time.ZoneId;
import java.time.format.DateTimeParseException;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Alert rules, mirroring app/alert-domain.cjs. Pure Java so it is unit-tested on the JVM.
 *
 * Times are local: "09:00 every weekday" follows the phone's time zone and daylight saving. A start time that
 * doesn't exist (the hour skipped in spring) moves forward by the gap; a time that happens twice (the hour
 * repeated in autumn) uses the first. A time range ending before its start ends the next day, so it can
 * cross midnight and last 23 or 25 hours on the nights the clocks change.
 */
final class Alerts {
    static final int MAX_ALERTS = 100, MAX_TITLE = 120, MAX_NOTE = 500, MAX_SNOOZES = 100, SNOOZE_MINUTES = 5;
    static final List<String> REPEATS = Arrays.asList("once", "daily", "weekdays"),
            STYLES = Arrays.asList("full", "card", "notification"),
            BLOCK_MODES = Arrays.asList("none", "current", "custom"),
            SOUNDS = Arrays.asList("chime", "bloom", "bell", "pulse", "silent", "custom");
    static final String WEBSITE = "website:",
            MEDIA_FILE = "[a-f0-9-]{36}\\.(mp3|wav|ogg|m4a|aac|flac|mp4|mov|webm|png|jpe?g|gif|webp)";

    /** One saved alert: the settings (as validateAlert) plus what happened last (as alerts-main.cjs). */
    static final class Alert {
        String id, title, note = "", date, time, repeat = "once", lengthMode = "duration", endTime, style = "card",
                blockMode = "none", sound = "chime", soundFile, soundName, banner, bannerName;
        int durationMinutes = 50, unlockDelayMinutes, volume = 65;
        /** Null means unlimited snoozes. */
        Integer snoozeLimit;
        boolean showDismiss = true, enabled = true;
        /** Package name or "website:domain" to label, as {path, name} on Windows. */
        final Map<String, String> apps = new LinkedHashMap<>();

        long lastOccurrence, snoozeAt, snoozeEnd, pending;
        int snoozeCount;
        String sessionId, lastResult = "";
        /** What this occurrence blocks, kept so a snooze can restart it. */
        final Map<String, String> occurrenceApps = new LinkedHashMap<>();
    }

    /** A start and end, in epoch milliseconds. */
    static final class Occurrence {
        final long start, end;
        Occurrence(long start, long end) { this.start = start; this.end = end; }
    }

    private Alerts() {}

    static LocalDate date(String value) {
        try {
            if (value != null && value.matches("\\d{4}-\\d{2}-\\d{2}")) return LocalDate.parse(value);
        } catch (DateTimeParseException ignored) { }
        throw new IllegalArgumentException("Choose a valid date.");
    }

    private static boolean isTime(String value) { return value != null && value.matches("([01]\\d|2[0-3]):[0-5]\\d"); }

    static boolean isWebsite(String path) { return path.startsWith(WEBSITE); }

    /** Checks and tidies an alert in place, with validateAlert's rules and messages. */
    static void validate(Alert a) {
        a.title = a.title == null ? "" : a.title.trim();
        if (a.title.isEmpty() || a.title.length() > MAX_TITLE) throw new IllegalArgumentException("Give your alert a task, up to 120 characters.");
        if (a.note == null) a.note = "";
        if (a.note.length() > MAX_NOTE) a.note = a.note.substring(0, MAX_NOTE);
        date(a.date);
        if (!isTime(a.time)) throw new IllegalArgumentException("Choose a valid start time.");
        if (!REPEATS.contains(a.repeat)) throw new IllegalArgumentException("Choose a repeat schedule.");
        if (!"duration".equals(a.lengthMode) && !"range".equals(a.lengthMode)) throw new IllegalArgumentException("Choose a duration or time range.");
        if (a.durationMinutes < 1 || a.durationMinutes > Session.MAX_MINUTES) throw new IllegalArgumentException("Choose 1–1,440 whole minutes.");
        if (!isTime(a.endTime)) throw new IllegalArgumentException("Choose a valid end time.");
        if ("range".equals(a.lengthMode) && a.endTime.equals(a.time)) throw new IllegalArgumentException("Start and end times must be different.");
        if (!STYLES.contains(a.style)) throw new IllegalArgumentException("Choose an alarm style.");
        if (a.snoozeLimit != null && (a.snoozeLimit < 0 || a.snoozeLimit > MAX_SNOOZES)) throw new IllegalArgumentException("Choose 0–100 snoozes, or unlimited.");
        if (!BLOCK_MODES.contains(a.blockMode)) throw new IllegalArgumentException("Choose which apps or websites to block.");
        if (a.apps.size() > Session.MAX_APPS) throw new IllegalArgumentException("Choose up to 100 apps or websites.");
        Map<String, String> apps = new LinkedHashMap<>();
        for (Map.Entry<String, String> app : a.apps.entrySet()) {
            String path = app.getKey();
            if (isWebsite(path)) path = WEBSITE + Websites.domain(path.substring(WEBSITE.length()));
            else if (!path.matches("[A-Za-z][A-Za-z0-9_]*(\\.[A-Za-z0-9_]+)+")) throw new IllegalArgumentException("Choose up to 100 apps or websites.");
            String name = app.getValue() == null || app.getValue().isEmpty() ? path : app.getValue();
            apps.put(path, name.substring(0, Math.min(100, name.length())));
        }
        a.apps.clear();
        a.apps.putAll(apps);
        if ("custom".equals(a.blockMode) && a.apps.isEmpty()) throw new IllegalArgumentException("Select apps or websites to block, or choose “No blocking”.");
        if (a.unlockDelayMinutes < 0 || a.unlockDelayMinutes > Session.MAX_DELAY) throw new IllegalArgumentException("Choose a release delay from 0 to 120 minutes.");
        if (!SOUNDS.contains(a.sound) || a.volume < 0 || a.volume > 100) throw new IllegalArgumentException("Choose a sound and volume.");
        // Media are copies inside Still's own folder, so a stored name can never point anywhere else.
        if ((a.soundFile != null && !a.soundFile.matches(MEDIA_FILE)) || (a.banner != null && !a.banner.matches(MEDIA_FILE)))
            throw new IllegalArgumentException("Choose a media file using the file picker.");
        if ("custom".equals(a.sound) && a.soundFile == null) throw new IllegalArgumentException("Choose your custom sound file.");
        if ("full".equals(a.style) && ("silent".equals(a.sound) || a.volume == 0)) throw new IllegalArgumentException("Full-screen alarms need an audible sound.");
    }

    private static long at(LocalDate day, String time, ZoneId zone) {
        return day.atTime(LocalTime.parse(time)).atZone(zone).toInstant().toEpochMilli();
    }

    /** The alert's window on a local day, or null if it doesn't happen that day. */
    static Occurrence on(Alert a, LocalDate day, ZoneId zone) {
        LocalDate first = date(a.date);
        if (day.isBefore(first) || ("once".equals(a.repeat) && !day.equals(first))) return null;
        if ("weekdays".equals(a.repeat) && (day.getDayOfWeek() == DayOfWeek.SATURDAY || day.getDayOfWeek() == DayOfWeek.SUNDAY)) return null;
        long start = at(day, a.time, zone);
        long end = start + a.durationMinutes * 60000L;
        if ("range".equals(a.lengthMode)) end = at(a.endTime.compareTo(a.time) < 0 ? day.plusDays(1) : day, a.endTime, zone);
        return new Occurrence(start, end);
    }

    private static LocalDate day(long ms, ZoneId zone) { return Instant.ofEpochMilli(ms).atZone(zone).toLocalDate(); }

    /** An occurrence that has started and hasn't been handled yet. It may already have ended (missed). */
    static Occurrence due(Alert a, long now, ZoneId zone) {
        if (!a.enabled) return null;
        // Catches up today's slot (or yesterday's overnight one) after a restart, never a backlog.
        LocalDate today = day(now, zone);
        for (LocalDate d : "once".equals(a.repeat) ? new LocalDate[] { date(a.date) } : new LocalDate[] { today, today.minusDays(1) }) {
            Occurrence o = on(a, d, zone);
            if (o != null && o.start <= now && o.start > a.lastOccurrence) return o;
        }
        return null;
    }

    /** When the alert next starts (or the running occurrence's start), or 0 if never. */
    static long next(Alert a, long now, ZoneId zone) {
        if (!a.enabled) return 0;
        Occurrence due = due(a, now, zone);
        if (due != null && due.end > now) return due.start;
        LocalDate first = date(a.date), today = day(now, zone);
        LocalDate from = today.isAfter(first) ? today : first;
        for (int offset = 0; offset < 8; offset++) {
            Occurrence o = on(a, from.plusDays(offset), zone);
            if (o != null && o.start > now && o.start > a.lastOccurrence) return o.start;
        }
        return 0;
    }

    /** When anything about this alert needs a look: a snooze returning, blocking to give up on, or the next start. */
    static long wake(Alert a, long now, ZoneId zone) {
        long wake = Long.MAX_VALUE;
        if (!a.enabled) return wake;
        if (a.snoozeAt > 0) wake = a.snoozeAt;
        if (a.pending > 0) wake = Math.min(wake, a.pending);
        long next = next(a, now, zone);
        if (next > now) wake = Math.min(wake, next);
        return wake;
    }

    static boolean canSnooze(Alert a) { return a.snoozeLimit == null || a.snoozeCount < a.snoozeLimit; }

    /** Changing when an alert happens forgets the last occurrence, so the new time can ring today. */
    static boolean scheduleChanged(Alert before, Alert after) {
        return !before.date.equals(after.date) || !before.time.equals(after.time) || !before.repeat.equals(after.repeat)
                || !before.lengthMode.equals(after.lengthMode) || before.durationMinutes != after.durationMinutes
                || !before.endTime.equals(after.endTime);
    }
}

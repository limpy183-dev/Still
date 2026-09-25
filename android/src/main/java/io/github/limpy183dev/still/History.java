package io.github.limpy183dev.still;

import java.time.LocalDate;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Progress figures for the history screen, mirroring focusMilliseconds, renderProgress and renderIntentions
 * in app/renderer.js: time is split across local calendar days, completed sessions count on the day they
 * finish, and recovered sessions contribute no focus time (snoozed alarm sessions count up to the snooze). Archived sessions still count. Pure Java.
 */
final class History {
    static final int[] RANGES = { 7, 30, 90 };
    static final int MAX_GOAL = 1440;

    static final class Record {
        String id, intention, outcome;
        long startedAt, endsAt, finishedAt;
        boolean archived;
        int targets;
    }

    static final class Day {
        final LocalDate date;
        final long start, end;
        double minutes;
        int sessions;
        Day(LocalDate date, long start, long end) { this.date = date; this.start = start; this.end = end; }
    }

    static final class Group {
        final String label;
        double minutes;
        int sessions;
        long last;
        Group(String label) { this.label = label; }
    }

    private History() {}

    /** Focus time inside [from, to); a running session (no finishedAt) counts up to now. */
    static long focusMs(Record r, long from, long to, long now) {
        if ("failed".equals(r.outcome) || "interrupted".equals(r.outcome) || "recovered".equals(r.outcome)) return 0;
        long end = Math.min(Math.min(r.finishedAt > 0 ? r.finishedAt : now, r.endsAt), to);
        return Math.max(0, end - Math.max(r.startedAt, from));
    }

    static String label(Record r) { return r.intention == null || r.intention.isEmpty() ? "Time to focus" : r.intention; }

    static int range(int days) {
        for (int r : RANGES) if (r == days) return r;
        return 30;
    }

    static int goal(int minutes) { return Math.max(1, Math.min(MAX_GOAL, minutes)); }

    /** The last {@code count} local days, oldest first. */
    static List<Day> days(List<Record> records, int count, LocalDate today, ZoneId zone, long now) {
        List<Day> out = new ArrayList<>();
        for (int i = count - 1; i >= 0; i--) {
            LocalDate date = today.minusDays(i);
            Day d = new Day(date, date.atStartOfDay(zone).toInstant().toEpochMilli(),
                    date.plusDays(1).atStartOfDay(zone).toInstant().toEpochMilli());
            for (Record r : records) {
                d.minutes += focusMs(r, d.start, d.end, now) / 60000.0;
                if ("completed".equals(r.outcome) && r.finishedAt >= d.start && r.finishedAt < d.end) d.sessions++;
            }
            out.add(d);
        }
        return out;
    }

    /** { days with focus, daily goals met, completion % (-1 when nothing finished), average finished minutes }. */
    static int[] summary(List<Record> records, List<Day> days, int goal, long now) {
        int active = 0, met = 0, finished = 0, completed = 0;
        long total = 0;
        for (Day d : days) {
            if (d.minutes > 0) active++;
            if (d.minutes >= goal) met++;
        }
        long from = days.get(0).start;
        for (Record r : records) {
            if (r.finishedAt < from || r.finishedAt > now) continue;
            if (!"completed".equals(r.outcome) && !"ended-early".equals(r.outcome)) continue;
            finished++;
            if ("completed".equals(r.outcome)) completed++;
            total += focusMs(r, 0, now, now);
        }
        return new int[] { active, met, finished == 0 ? -1 : Math.round(completed * 100f / finished),
                finished == 0 ? 0 : (int) (total / finished / 60000) };
    }

    /** Time per intention in [from, now), most time first (then most recent). */
    static List<Group> intentions(List<Record> records, long from, long now) {
        Map<String, Group> groups = new LinkedHashMap<>();
        for (Record r : records) {
            double minutes = focusMs(r, from, now, now) / 60000.0;
            if (minutes <= 0) continue;
            Group g = groups.computeIfAbsent(label(r), Group::new);
            g.minutes += minutes;
            g.sessions++;
            g.last = Math.max(g.last, r.startedAt);
        }
        List<Group> out = new ArrayList<>(groups.values());
        out.sort((a, b) -> a.minutes != b.minutes ? Double.compare(b.minutes, a.minutes) : Long.compare(b.last, a.last));
        return out;
    }

    /** "45m", "2h", "1h 5m", like readableTime on Windows. */
    static String readable(long minutes) {
        return minutes >= 60 ? (minutes / 60) + "h" + (minutes % 60 > 0 ? " " + minutes % 60 + "m" : "") : minutes + "m";
    }
}

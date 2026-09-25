package io.github.limpy183dev.still;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;

import org.junit.Test;

import java.time.LocalDate;
import java.time.ZoneId;
import java.util.Arrays;
import java.util.List;

public class HistoryTest {
    private static final ZoneId ZONE = ZoneId.of("Europe/London");
    private static final LocalDate TODAY = LocalDate.of(2026, 3, 30); // The day after the clocks go forward.
    private static final long MIN = 60_000;

    private static long at(LocalDate day, int hour, int minute) {
        return day.atTime(hour, minute).atZone(ZONE).toInstant().toEpochMilli();
    }

    private static History.Record record(String intention, String outcome, long start, long minutes, long finished) {
        History.Record r = new History.Record();
        r.id = intention + start;
        r.intention = intention;
        r.outcome = outcome;
        r.startedAt = start;
        r.endsAt = start + minutes * MIN;
        r.finishedAt = finished;
        return r;
    }

    @Test public void focusTimeFollowsTheWindowsRules() {
        long start = at(TODAY, 9, 0), now = at(TODAY, 12, 0);
        assertEquals(50 * MIN, History.focusMs(record("a", "completed", start, 50, start + 55 * MIN), 0, now, now));
        assertEquals(20 * MIN, History.focusMs(record("a", "ended-early", start, 50, start + 20 * MIN), 0, now, now));
        assertEquals(0, History.focusMs(record("a", "recovered", start, 50, start + 20 * MIN), 0, now, now));
        // A running session counts up to now.
        assertEquals(30 * MIN, History.focusMs(record("a", null, now - 30 * MIN, 50, 0), 0, now, now));
    }

    @Test public void daysSplitAtLocalMidnightAndCountCompletedSessionsWhenTheyFinish() {
        LocalDate yesterday = TODAY.minusDays(1);
        long start = at(yesterday, 23, 30), now = at(TODAY, 12, 0);
        List<History.Record> records = Arrays.asList(record("Essay", "completed", start, 60, start + 60 * MIN));
        List<History.Day> days = History.days(records, 7, TODAY, ZONE, now);
        assertEquals(7, days.size());
        assertEquals(TODAY, days.get(6).date);
        assertEquals(30, days.get(5).minutes, 0.001);
        assertEquals(30, days.get(6).minutes, 0.001);
        assertEquals(0, days.get(5).sessions);
        assertEquals(1, days.get(6).sessions);
        // 29 March 2026 is 23 hours long in London.
        assertEquals(23 * 60 * MIN, days.get(5).end - days.get(5).start);
    }

    @Test public void summaryCountsGoalsCompletionAndAverage() {
        long now = at(TODAY, 20, 0), a = at(TODAY, 9, 0), b = at(TODAY, 14, 0), c = at(TODAY.minusDays(2), 9, 0);
        List<History.Record> records = Arrays.asList(
                record("Essay", "completed", a, 60, a + 60 * MIN),
                record("Essay", "ended-early", b, 60, b + 30 * MIN),
                record("Reading", "completed", c, 20, c + 20 * MIN),
                record("Old", "completed", at(TODAY.minusDays(40), 9, 0), 60, at(TODAY.minusDays(40), 10, 0)));
        List<History.Day> days = History.days(records, 7, TODAY, ZONE, now);
        // 2 days with focus, 1 goal met (90 ≥ 60), 2 of 3 finished completed, (60 + 30 + 20) / 3 = 36 minutes.
        assertArrayEquals(new int[] { 2, 1, 67, 36 }, History.summary(records, days, 60, now));
        assertArrayEquals(new int[] { 0, 0, -1, 0 }, History.summary(Arrays.asList(),
                History.days(Arrays.asList(), 7, TODAY, ZONE, now), 60, now));

        List<History.Group> groups = History.intentions(records, days.get(0).start, now);
        assertEquals(2, groups.size());
        assertEquals("Essay", groups.get(0).label);
        assertEquals(90, groups.get(0).minutes, 0.001);
        assertEquals(2, groups.get(0).sessions);
        assertEquals(b, groups.get(0).last);
    }

    @Test public void settingsAndLabelsAreClamped() {
        assertEquals(30, History.range(14));
        assertEquals(90, History.range(90));
        assertEquals(1, History.goal(0));
        assertEquals(1440, History.goal(5000));
        assertEquals("45m", History.readable(45));
        assertEquals("2h", History.readable(120));
        assertEquals("1h 5m", History.readable(65));
        assertEquals("Time to focus", History.label(record("", "completed", 0, 1, 1)));
    }
}

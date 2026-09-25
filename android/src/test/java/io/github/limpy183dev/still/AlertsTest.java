package io.github.limpy183dev.still;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import java.time.LocalDate;
import java.time.ZoneId;
import java.time.ZonedDateTime;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;

public class AlertsTest {
    private static final ZoneId NY = ZoneId.of("America/New_York");
    private static final long MIN = 60000L;

    private static Alerts.Alert alert(String date, String time, String repeat) {
        Alerts.Alert a = new Alerts.Alert();
        a.id = "a";
        a.title = "  Write  ";
        a.date = date;
        a.time = time;
        a.repeat = repeat;
        a.endTime = "10:00";
        return a;
    }

    private static long ms(String local) { return ZonedDateTime.of(java.time.LocalDateTime.parse(local), NY).toInstant().toEpochMilli(); }

    private static String error(Alerts.Alert a) {
        return assertThrows(IllegalArgumentException.class, () -> Alerts.validate(a)).getMessage();
    }

    @Test public void validatesLikeTheWindowsEditor() {
        Alerts.Alert a = alert("2026-09-25", "09:00", "once");
        Alerts.validate(a);
        assertEquals("Write", a.title);
        a.title = " ";
        assertEquals("Give your alert a task, up to 120 characters.", error(a));
        a = alert("2026-02-30", "09:00", "once");
        assertEquals("Choose a valid date.", error(a));
        a = alert("2026-09-25", "24:00", "once");
        assertEquals("Choose a valid start time.", error(a));
        a = alert("2026-09-25", "10:00", "once");
        a.lengthMode = "range";
        assertEquals("Start and end times must be different.", error(a));
        a = alert("2026-09-25", "09:00", "once");
        a.style = "full";
        a.sound = "silent";
        assertEquals("Full-screen alarms need an audible sound.", error(a));
        a = alert("2026-09-25", "09:00", "once");
        a.sound = "custom";
        assertEquals("Choose your custom sound file.", error(a));
        a.soundFile = "../state.json";
        assertEquals("Choose a media file using the file picker.", error(a));
        a.soundFile = "0b7c1a64-7d0e-4a8b-9c3e-2f1d5e6a7b8c.mp3";
        Alerts.validate(a);
        a.snoozeLimit = 101;
        assertEquals("Choose 0–100 snoozes, or unlimited.", error(a));
        a = alert("2026-09-25", "09:00", "once");
        a.blockMode = "custom";
        assertEquals("Select apps or websites to block, or choose “No blocking”.", error(a));
        a.apps.put("website:https://www.YouTube.com/watch", "");
        a.apps.put("com.example.video", "Video");
        Alerts.validate(a);
        assertTrue(a.apps.containsKey("website:youtube.com"));
        a.apps.put("not a package", "x");
        assertEquals("Choose up to 100 apps or websites.", error(a));
    }

    @Test public void repeatsOnceDailyOrOnWeekdays() {
        Alerts.Alert once = alert("2026-09-25", "09:00", "once"), weekdays = alert("2026-09-25", "09:00", "weekdays");
        assertEquals(ms("2026-09-25T09:00"), Alerts.on(once, LocalDate.parse("2026-09-25"), NY).start);
        assertEquals(ms("2026-09-25T09:50"), Alerts.on(once, LocalDate.parse("2026-09-25"), NY).end);
        assertNull(Alerts.on(once, LocalDate.parse("2026-09-26"), NY));
        assertNull(Alerts.on(weekdays, LocalDate.parse("2026-09-24"), NY)); // Before the start date.
        assertNull(Alerts.on(weekdays, LocalDate.parse("2026-09-26"), NY)); // Saturday.
        // Friday 09:30: the next weekday alarm is Monday.
        assertEquals(ms("2026-09-28T09:00"), Alerts.next(weekdays, ms("2026-09-25T09:30") + 60 * MIN, NY));
        // A one-time alert months away is still found.
        assertEquals(ms("2027-03-01T09:00"), Alerts.next(alert("2027-03-01", "09:00", "once"), ms("2026-09-25T12:00"), NY));
    }

    @Test public void aRangeEndingBeforeItsStartCrossesMidnight() {
        Alerts.Alert a = alert("2026-09-25", "22:00", "daily");
        a.lengthMode = "range";
        a.endTime = "06:30";
        Alerts.Occurrence o = Alerts.on(a, LocalDate.parse("2026-09-25"), NY);
        assertEquals(ms("2026-09-26T06:30"), o.end);
        // After midnight, yesterday's overnight window is still due, once.
        Alerts.Occurrence due = Alerts.due(a, ms("2026-09-26T01:00"), NY);
        assertEquals(ms("2026-09-25T22:00"), due.start);
        a.lastOccurrence = due.start;
        assertNull(Alerts.due(a, ms("2026-09-26T01:00"), NY));
    }

    @Test public void followsDaylightSavingTime() {
        Alerts.Alert a = alert("2026-03-01", "02:30", "daily");
        // 02:30 doesn't exist on 8 March (clocks jump 02:00 → 03:00), so it rings at 03:30.
        assertEquals(ms("2026-03-08T03:30"), Alerts.on(a, LocalDate.parse("2026-03-08"), NY).start);
        // 09:00 stays 09:00 local on both sides of the change, 23 hours apart.
        Alerts.Alert nine = alert("2026-03-01", "09:00", "daily");
        long sat = Alerts.on(nine, LocalDate.parse("2026-03-07"), NY).start, sun = Alerts.on(nine, LocalDate.parse("2026-03-08"), NY).start;
        assertEquals(23 * 60 * MIN, sun - sat);
        // 01:30 happens twice on 1 November; it rings once, at the first.
        Alerts.Alert twice = alert("2026-10-01", "01:30", "daily");
        long first = Alerts.on(twice, LocalDate.parse("2026-11-01"), NY).start;
        assertEquals(ZonedDateTime.parse("2026-11-01T01:30-04:00").toInstant().toEpochMilli(), first);
        twice.lastOccurrence = first;
        assertNull(Alerts.due(twice, first + 60 * MIN, NY)); // The repeated 01:30 is not a new occurrence.
        // A range over the autumn change lasts 25 hours minus a minute, which a scheduled session allows.
        Alerts.Alert range = alert("2026-10-31", "00:00", "once");
        range.lengthMode = "range";
        range.endTime = "23:59";
        Alerts.Occurrence o = Alerts.on(range, LocalDate.parse("2026-11-01"), NY);
        assertTrue(o == null); // "once" is only on its date…
        range.date = "2026-11-01";
        o = Alerts.on(range, LocalDate.parse("2026-11-01"), NY);
        assertEquals(24 * 60 * MIN + 59 * MIN, o.end - o.start);
        assertTrue(o.end - o.start <= Session.MAX_SCHEDULED_MS);
    }

    @Test public void dueCatchesUpTodayButMarksMissedWindows() {
        Alerts.Alert a = alert("2026-09-20", "09:00", "daily");
        Alerts.Occurrence missed = Alerts.due(a, ms("2026-09-25T12:00"), NY);
        assertEquals(ms("2026-09-25T09:00"), missed.start);
        assertTrue(missed.end <= ms("2026-09-25T12:00")); // Ended: shown as missed, not rung.
        a.lastOccurrence = missed.start;
        assertNull(Alerts.due(a, ms("2026-09-25T12:00"), NY));
        assertEquals(ms("2026-09-26T09:00"), Alerts.next(a, ms("2026-09-25T12:00"), NY));
        a.enabled = false;
        assertEquals(0, Alerts.next(a, ms("2026-09-25T12:00"), NY));
        assertEquals(Long.MAX_VALUE, Alerts.wake(a, ms("2026-09-25T12:00"), NY));
    }

    @Test public void wakesForTheEarliestThingDue() {
        Alerts.Alert a = alert("2026-09-20", "09:00", "daily");
        long now = ms("2026-09-25T09:10");
        a.lastOccurrence = ms("2026-09-25T09:00");
        a.snoozeAt = now + 5 * MIN;
        a.pending = ms("2026-09-25T09:50");
        assertEquals(now + 5 * MIN, Alerts.wake(a, now, NY));
        a.snoozeAt = 0;
        assertEquals(ms("2026-09-25T09:50"), Alerts.wake(a, now, NY));
        a.pending = 0;
        assertEquals(ms("2026-09-26T09:00"), Alerts.wake(a, now, NY));
    }

    @Test public void snoozeLimitsAndScheduleChanges() {
        Alerts.Alert a = alert("2026-09-25", "09:00", "daily");
        assertTrue(Alerts.canSnooze(a));
        a.snoozeLimit = 2;
        a.snoozeCount = 2;
        assertFalse(Alerts.canSnooze(a));
        Alerts.Alert b = alert("2026-09-25", "09:00", "daily");
        b.title = "Another title";
        assertFalse(Alerts.scheduleChanged(a, b));
        b.time = "09:05";
        assertTrue(Alerts.scheduleChanged(a, b));
    }

    @Test public void alarmSessionsEndAtTheirFixedTime() {
        long wall = 1_700_000_000_000L;
        Map<String, String> apps = new LinkedHashMap<>();
        apps.put("com.example.video", "Video");
        Session.Clock now = new Session.Clock(wall, 5000, 3);
        Session s = Session.startUntil("s", "Write", wall + 90 * MIN + 30000, 0, true, apps, Collections.emptyList(), now);
        assertEquals(91, s.durationMinutes);
        assertEquals(90 * MIN + 30000, s.remaining(now));
        // A 25-hour window is allowed and not cut to 1,440 minutes.
        Session day = Session.startUntil("d", "Rest", wall + 1500 * MIN, 0, true, apps, Collections.emptyList(), now);
        assertEquals(1500 * MIN, day.remaining(now));
        // After a reboot with the clock set back, it still can't run longer than its window.
        assertEquals(1500 * MIN, day.remaining(new Session.Clock(wall - 600 * MIN, 1000, 4)));
        assertThrows(IllegalArgumentException.class, () -> Session.startUntil("x", "", wall, 0, true, apps, Collections.emptyList(), now));
        assertThrows(IllegalArgumentException.class, () -> Session.startUntil("x", "", wall + 1501 * MIN, 0, true, apps, Collections.emptyList(), now));
    }

    @Test public void snoozedSessionsCountTheirFocusTime() {
        History.Record r = new History.Record();
        r.outcome = "snoozed";
        r.startedAt = 0;
        r.endsAt = 60 * MIN;
        r.finishedAt = 20 * MIN;
        assertEquals(20 * MIN, History.focusMs(r, 0, 60 * MIN, 60 * MIN));
    }
}

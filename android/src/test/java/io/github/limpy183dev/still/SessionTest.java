package io.github.limpy183dev.still;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import java.util.LinkedHashMap;
import java.util.Map;

public class SessionTest {
    private static final long MIN = 60000L, WALL = 1_700_000_000_000L;

    private static Session.Clock at(long wall, long elapsed, int boot) { return new Session.Clock(wall, elapsed, boot); }

    private static Session session(int minutes, int delay) {
        Map<String, String> apps = new LinkedHashMap<>();
        apps.put("com.example.video", "Video");
        return Session.start("id", "  Write  ", minutes, delay, true, apps, at(WALL, 1000, 5));
    }

    @Test public void expiresAfterItsDuration() {
        Session s = session(30, 0);
        assertEquals("Write", s.intention);
        assertFalse(s.expired(at(WALL + 29 * MIN, 1000 + 29 * MIN, 5)));
        assertTrue(s.expired(at(WALL + 30 * MIN, 1000 + 30 * MIN, 5)));
    }

    @Test public void changingTheClockDoesNotEndOrExtendIt() {
        Session s = session(30, 0);
        // Clock moved a day forward, then a day back, one minute in: 29 minutes still left either way.
        assertEquals(29 * MIN, s.remaining(at(WALL + 24 * 60 * MIN, 1000 + MIN, 5)));
        assertEquals(29 * MIN, s.remaining(at(WALL - 24 * 60 * MIN, 1000 + MIN, 5)));
    }

    @Test public void rebootFallsBackToTheWallClockAndReanchors() {
        Session s = session(30, 0);
        Session.Clock afterBoot = at(WALL + 10 * MIN, 20_000, 6);
        assertEquals(20 * MIN, s.remaining(afterBoot));
        assertTrue(s.anchor(afterBoot));
        // Now a clock change in the new boot is ignored again.
        assertEquals(15 * MIN, s.remaining(at(WALL - 60 * MIN, 20_000 + 5 * MIN, 6)));
    }

    @Test public void cannotBeStretchedPastItsDuration() {
        Session s = session(30, 0);
        // Clock moved back an hour before a reboot.
        assertEquals(30 * MIN, s.remaining(at(WALL - 60 * MIN, 500, 6)));
    }

    @Test public void anchorIgnoresJitterInTheSameBoot() {
        Session s = session(30, 0);
        assertFalse(s.anchor(at(WALL + MIN + 3, 1000 + MIN, 5)));
    }

    @Test public void releaseWaitsForTheDelay() {
        Session s = session(60, 10);
        Session.Clock now = at(WALL + MIN, 1000 + MIN, 5);
        assertFalse(s.canEnd(now));
        s.requestUnlock(now);
        s.requestUnlock(at(WALL + 5 * MIN, 1000 + 5 * MIN, 5)); // A second request keeps the first time.
        assertFalse(s.canEnd(at(WALL + 10 * MIN, 1000 + 10 * MIN, 5)));
        assertTrue(s.canEnd(at(WALL + 11 * MIN, 1000 + 11 * MIN, 5)));
        // The wait ignores clock changes too.
        assertFalse(s.canEnd(at(WALL + 60 * MIN, 1000 + 2 * MIN, 5)));
    }

    @Test public void cancellingRestartsTheFullWait() {
        Session s = session(60, 10);
        s.requestUnlock(at(WALL, 1000, 5));
        s.cancelUnlock();
        assertFalse(s.unlockRequested());
        s.requestUnlock(at(WALL + 9 * MIN, 1000 + 9 * MIN, 5));
        assertFalse(s.canEnd(at(WALL + 11 * MIN, 1000 + 11 * MIN, 5)));
        assertTrue(s.canEnd(at(WALL + 19 * MIN, 1000 + 19 * MIN, 5)));
    }

    @Test public void noDelayCanEndAnyTime() {
        assertTrue(session(60, 0).canEnd(at(WALL, 1000, 5)));
    }

    @Test public void unknownBootCountUsesTheWallClock() {
        Map<String, String> apps = new LinkedHashMap<>();
        apps.put("a", "A");
        Session s = Session.start("id", "", 30, 0, false, apps, at(WALL, 1000, -1));
        assertEquals("Time to focus", s.intention);
        assertEquals(20 * MIN, s.remaining(at(WALL + 10 * MIN, 1000, -1)));
    }

    @Test public void validatesLimits() {
        assertThrows(IllegalArgumentException.class, () -> Session.validate(0, 0, 1));
        assertThrows(IllegalArgumentException.class, () -> Session.validate(1441, 0, 1));
        assertThrows(IllegalArgumentException.class, () -> Session.validate(30, -1, 1));
        assertThrows(IllegalArgumentException.class, () -> Session.validate(30, 121, 1));
        assertThrows(IllegalArgumentException.class, () -> Session.validate(30, 0, 0));
        assertThrows(IllegalArgumentException.class, () -> Session.validate(30, 0, 101));
        Session.validate(1440, 120, 100);
    }
}

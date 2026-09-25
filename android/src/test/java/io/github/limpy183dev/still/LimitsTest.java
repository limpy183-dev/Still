package io.github.limpy183dev.still;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class LimitsTest {
    private static int at(int hour, int minute) { return hour * 60 + minute; }

    @Test public void bedtimeCanCrossMidnight() {
        Limits l = new Limits(); // 22:30–07:00 by default, like Windows.
        assertTrue(l.inBedtime(at(22, 30)));
        assertTrue(l.inBedtime(at(3, 0)));
        assertFalse(l.inBedtime(at(7, 0)));
        assertFalse(l.inBedtime(at(12, 0)));
        l.setBedtime(true, "13:00", "14:00");
        assertTrue(l.inBedtime(at(13, 59)));
        assertFalse(l.inBedtime(at(14, 0)));
        l.setBedtime(true, "09:00", "09:00");
        assertFalse(l.inBedtime(at(9, 0))); // Equal times mean never.
    }

    @Test public void invalidTimesKeepThePreviousOnes() {
        Limits l = new Limits();
        l.setBedtime(true, "24:00", "7:00");
        assertEquals("22:30", l.from);
        assertEquals("07:00", l.to);
    }

    @Test public void blocksForBedtimeOrAUsedAllowance() {
        Limits l = new Limits();
        l.put("https://www.youtube.com/watch?v=1", 30, true);
        l.put("reddit.com", 0, false);
        Limits.Site yt = l.find("m.youtube.com");
        assertEquals("youtube.com", yt.domain);
        assertNull(l.find("notyoutube.com"));
        assertNull(l.blocked(yt, 29 * 60 + 59, at(12, 0)));
        assertEquals(Limits.LIMIT, l.blocked(yt, 30 * 60, at(12, 0)));
        assertEquals(Limits.BEDTIME, l.blocked(yt, 0, at(23, 0)));
        l.setBedtime(false, null, null);
        assertNull(l.blocked(yt, 0, at(23, 0)));
        assertNull(l.blocked(l.find("reddit.com"), 99999, at(12, 0))); // 0 minutes = no daily limit.
    }

    @Test public void activeOnlyWhenSomethingCanBlock() {
        Limits l = new Limits();
        assertFalse(l.active());
        l.put("reddit.com", 0, false);
        assertFalse(l.active());
        l.put("reddit.com", 0, true);
        assertTrue(l.active());
        l.setBedtime(false, null, null);
        assertFalse(l.active());
        l.put("youtube.com", 15, false);
        assertTrue(l.active());
    }

    @Test public void clampsReplacesAndCaps() {
        Limits l = new Limits();
        l.put("youtube.com", 5000, false);
        assertEquals(1440, l.find("youtube.com").minutes);
        l.put("www.youtube.com", -3, true);
        assertEquals(1, l.sites().size());
        assertEquals(0, l.find("youtube.com").minutes);
        for (int i = 0; l.sites().size() < Limits.MAX_SITES; i++) l.put("site" + i + ".com", 10, false);
        assertThrows(IllegalArgumentException.class, () -> l.put("one-more.com", 10, false));
        l.put("youtube.com", 20, false); // Editing an existing site still works when full.
        assertThrows(IllegalArgumentException.class, () -> l.put("localhost", 10, false));
    }
}

package io.github.limpy183dev.still;

import static org.junit.Assert.assertEquals;

import org.junit.Test;

/** The Focus space timer reads like formatClock in app/renderer.js. */
public class ClockTest {
    @Test
    public void wholeMinutesThenSecondsRoundedUp() {
        assertEquals("50:00", MainActivity.clock(50 * 60_000));
        assertEquals("90:00", MainActivity.clock(90 * 60_000));
        assertEquals("24:55", MainActivity.clock(24 * 60_000 + 54_001));
        assertEquals("00:01", MainActivity.clock(1));
        assertEquals("00:00", MainActivity.clock(0));
        assertEquals("00:00", MainActivity.clock(-5_000));
        assertEquals("1440:00", MainActivity.clock(1440 * 60_000L));
    }
}

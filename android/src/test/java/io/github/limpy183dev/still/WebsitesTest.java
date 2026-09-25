package io.github.limpy183dev.still;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import java.util.Arrays;

/** Same cases as tests/websites.test.cjs where they overlap, so both platforms accept the same input. */
public class WebsitesTest {
    @Test public void normalisesUrlsAndDomains() {
        assertEquals("youtube.com", Websites.domain("youtube.com"));
        assertEquals("youtube.com", Websites.domain("https://www.YouTube.com/watch?v=abc#t=1"));
        assertEquals("m.youtube.com", Websites.domain("http://m.youtube.com:8080/path"));
        assertEquals("example.com", Websites.domain("example.com."));
        assertEquals("xn--bcher-kva.example", Websites.domain("bücher.example"));
    }

    @Test public void rejectsWhatWindowsRejects() {
        for (String bad : new String[] { "", "not a site", "*.youtube.com", "ftp://example.com", "https://user:pw@example.com",
                "192.168.1.1", "[::1]", "localhost", "printer.local", "site.test", "x".repeat(2049), "example.com\\path" })
            assertThrows(bad, IllegalArgumentException.class, () -> Websites.domain(bad));
    }

    @Test public void matchesAtLabelBoundaries() {
        assertTrue(Websites.matches("youtube.com", "youtube.com"));
        assertTrue(Websites.matches("m.youtube.com", "youtube.com"));
        assertFalse(Websites.matches("notyoutube.com", "youtube.com"));
        assertFalse(Websites.matches("youtube.com.evil.net", "youtube.com"));
        assertEquals("youtube.com", Websites.blockedBy("music.youtube.com", Arrays.asList("reddit.com", "youtube.com")));
        assertNull(Websites.blockedBy(null, Arrays.asList("youtube.com")));
    }

    @Test public void readsBrowserAddressBars() {
        assertEquals("youtube.com", Websites.hostOf("youtube.com/watch?v=1"));
        assertEquals("youtube.com", Websites.hostOf(" https://www.youtube.com/ "));
        assertEquals("m.reddit.com", Websites.hostOf("m.reddit.com"));
        assertNull(Websites.hostOf("cute cat videos"));   // Search text.
        assertNull(Websites.hostOf("chrome://newtab"));   // Browser page.
        assertNull(Websites.hostOf("YouTube"));           // A page title, not an address.
        assertNull(Websites.hostOf(""));
        assertNull(Websites.hostOf(null));
    }
}

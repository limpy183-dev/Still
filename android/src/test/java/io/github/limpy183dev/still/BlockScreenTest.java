package io.github.limpy183dev.still;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import java.util.Arrays;
import java.util.Collections;
import java.util.List;

public class BlockScreenTest {
    private static final List<String> NONE = Collections.emptyList();

    @Test public void presetsUseTheirOwnWords() {
        BlockScreen dusk = BlockScreen.of("dusk", "ignored", "ignored", "", true, NONE);
        assertEquals("Stay with your intention.", dusk.headline());
        assertEquals(BlockScreen.presetText("dusk"), dusk.body());
        assertFalse(dusk.image); // Images belong to custom screens only.
        assertEquals("Make room for what matters.", BlockScreen.of(null, "", "", "", false, NONE).headline());
    }

    @Test public void customFallsBackToQuietGardenWords() {
        BlockScreen empty = BlockScreen.of("custom", "", "", "", true, NONE);
        assertEquals(BlockScreen.presetTitle("garden"), empty.headline());
        assertTrue(empty.image);
        BlockScreen mine = BlockScreen.of("custom", "Back to the essay", "x".repeat(1500), "", false, NONE);
        assertEquals("Back to the essay", mine.headline());
        assertEquals(BlockScreen.MAX_TEXT, mine.body().length());
        assertEquals(BlockScreen.MAX_TITLE, BlockScreen.of("custom", "t".repeat(200), "", "", false, NONE).title.length());
    }

    @Test public void redirectMustBeHttpsAndOutsideBlockedSites() {
        List<String> blocked = Arrays.asList("youtube.com");
        BlockScreen ok = BlockScreen.of("redirect", "", "", "https://example.org/notes", false, blocked);
        assertEquals("https://example.org/notes", ok.redirect);
        assertEquals(BlockScreen.GARDEN, ok.style()); // Apps still need a look.
        for (String bad : new String[] { "http://example.org", "example.org", "https://user@example.org", "https://localhost/",
                "https://m.youtube.com/feed", "ftp://example.org", "" })
            assertThrows(bad, IllegalArgumentException.class, () -> BlockScreen.of("redirect", "", "", bad, false, blocked));
        // A domain that only looks similar is fine.
        BlockScreen.of("redirect", "", "", "https://notyoutube.com", false, blocked);
    }

    @Test public void rejectsUnknownModes() {
        assertThrows(IllegalArgumentException.class, () -> BlockScreen.of("neon", "", "", "", false, NONE));
    }
}

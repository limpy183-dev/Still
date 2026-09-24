package io.github.limpy183dev.still;

import java.net.URI;
import java.net.URISyntaxException;
import java.util.Collection;
import java.util.Locale;

/**
 * The screen shown when something is blocked, mirroring presets/screen() in app/websites.js. A copy is
 * frozen into each session, like on Windows. Pure Java.
 */
final class BlockScreen {
    static final String GARDEN = "garden", DUSK = "dusk", PAPER = "paper", CUSTOM = "custom", REDIRECT = "redirect";
    static final int MAX_TITLE = 120, MAX_TEXT = 1000;

    final String mode, title, text, redirect;
    /** Whether a custom image goes with this screen (stored as a file next to the state). */
    final boolean image;

    private BlockScreen(String mode, String title, String text, String redirect, boolean image) {
        this.mode = mode; this.title = title; this.text = text; this.redirect = redirect; this.image = image;
    }

    static final BlockScreen DEFAULT = new BlockScreen(GARDEN, "", "", "", false);

    static String presetTitle(String mode) {
        switch (mode) {
            case DUSK: return "Stay with your intention.";
            case PAPER: return "One thing at a time.";
            default: return "Make room for what matters.";
        }
    }

    static String presetText(String mode) {
        switch (mode) {
            case DUSK: return "You chose this time for yourself. Take a breath, then begin again.";
            case PAPER: return "You don’t need to do everything. Just the thing in front of you.";
            default: return "Let this distraction wait. Your next small step deserves your attention.";
        }
    }

    /** The look to draw: a redirect still needs one for blocked apps and Still's settings. */
    String style() { return REDIRECT.equals(mode) ? GARDEN : mode; }

    String headline() { return CUSTOM.equals(mode) && !title.isEmpty() ? title : presetTitle(style()); }

    String body() { return CUSTOM.equals(mode) && !text.isEmpty() ? text : presetText(style()); }

    /**
     * Validates like screen() on Windows: a known mode, bounded text, an image only for a custom screen, and
     * a redirect that is HTTPS and outside the blocked websites. Throws with a user-facing message.
     */
    static BlockScreen of(String mode, String title, String text, String redirect, boolean image, Collection<String> blocked) {
        if (mode == null) mode = GARDEN;
        switch (mode) {
            case GARDEN: case DUSK: case PAPER: case CUSTOM: case REDIRECT: break;
            default: throw new IllegalArgumentException("Choose a website block screen.");
        }
        String safeTitle = clip(title, MAX_TITLE), safeText = clip(text, MAX_TEXT), url = "";
        if (REDIRECT.equals(mode)) {
            String host;
            try {
                URI uri = new URI(redirect == null ? "" : redirect.trim());
                if (!"https".equalsIgnoreCase(uri.getScheme()) || uri.getRawUserInfo() != null || uri.getHost() == null
                        || uri.toString().length() > 2048) throw new IllegalArgumentException();
                host = Websites.domain(uri.getHost().toLowerCase(Locale.ROOT));
                url = uri.toString();
            } catch (URISyntaxException | IllegalArgumentException e) {
                throw new IllegalArgumentException("Enter a full redirect URL, beginning with https://.");
            }
            if (Websites.blockedBy(host, blocked) != null)
                throw new IllegalArgumentException("Choose an HTTPS destination outside your blocked websites.");
        }
        return new BlockScreen(mode, safeTitle, safeText, url, image && CUSTOM.equals(mode));
    }

    private static String clip(String value, int max) {
        String text = value == null ? "" : value;
        return text.substring(0, Math.min(max, text.length()));
    }
}

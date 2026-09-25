package io.github.limpy183dev.still;

import java.net.IDN;
import java.util.Collection;
import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Website domains, mirroring app/websites.js: the same inputs are accepted and matched the same way. Pure Java. */
final class Websites {
    private static final Pattern SCHEME = Pattern.compile("^([a-z][a-z\\d+.-]*)://", Pattern.CASE_INSENSITIVE);
    private static final Pattern HOST = Pattern.compile(
            "^(?=.{1,253}$)(?:[a-z\\d](?:[a-z\\d-]{0,61}[a-z\\d])?\\.)+[a-z](?:[a-z\\d-]{0,61}[a-z\\d])?$");
    private static final Pattern RESERVED = Pattern.compile("\\.(localhost|local|internal|test|invalid)$");

    private Websites() {}

    /** Normalises a pasted URL or typed domain to its host, like "youtube.com". Throws with a user-facing message. */
    static String domain(String value) {
        if (value == null || value.length() > 2048 || value.matches("(?s).*[\\s\\\\*].*"))
            throw new IllegalArgumentException("Enter a website such as youtube.com or paste its URL.");
        String rest = value;
        Matcher scheme = SCHEME.matcher(value);
        if (scheme.find()) {
            String name = scheme.group(1).toLowerCase(Locale.ROOT);
            if (!name.equals("http") && !name.equals("https")) throw invalid();
            rest = value.substring(scheme.end());
        }
        int end = rest.length();
        for (char c : new char[] { '/', '?', '#' }) {
            int at = rest.indexOf(c);
            if (at >= 0 && at < end) end = at;
        }
        String host = rest.substring(0, end);
        if (host.contains("@") || host.startsWith("[")) throw invalid();
        host = host.replaceFirst(":\\d{1,5}$", "");
        try {
            host = IDN.toASCII(host).toLowerCase(Locale.ROOT);
        } catch (IllegalArgumentException e) {
            throw new IllegalArgumentException("Enter a valid website address.");
        }
        if (host.endsWith(".")) host = host.substring(0, host.length() - 1);
        if (host.startsWith("www.")) host = host.substring(4);
        if (!HOST.matcher(host).matches() || RESERVED.matcher(host).find()) throw invalid();
        return host;
    }

    private static IllegalArgumentException invalid() {
        return new IllegalArgumentException("Use a public website domain, without credentials, wildcards, or an IP address.");
    }

    /** Label-boundary match: blocking youtube.com covers m.youtube.com but not notyoutube.com. */
    static boolean matches(String host, String blocked) {
        return host.equals(blocked) || host.endsWith("." + blocked);
    }

    /** The blocked domain that covers {@code host}, or null. */
    static String blockedBy(String host, Collection<String> blocked) {
        if (host == null) return null;
        for (String domain : blocked) if (matches(host, domain)) return domain;
        return null;
    }

    /** The host shown in a browser's address bar ("youtube.com/watch?v=1"), or null for search text or browser pages. */
    static String hostOf(String addressBar) {
        if (addressBar == null) return null;
        String text = addressBar.trim();
        if (text.isEmpty() || text.contains(" ")) return null;
        try {
            return domain(text);
        } catch (IllegalArgumentException e) {
            return null;
        }
    }
}

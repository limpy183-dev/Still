package io.github.limpy183dev.still;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Daily website limits and bedtime, mirroring limits/inBedtime/limitBlocks in app/websites.js. Pure Java.
 * They apply outside focus sessions and can be changed at any time, like on Windows.
 */
final class Limits {
    static final String[] RECOMMENDED = { "youtube.com", "instagram.com", "tiktok.com", "reddit.com", "x.com" };
    static final int MAX_SITES = 100;
    static final String LIMIT = "limit", BEDTIME = "bedtime";

    static final class Site {
        final String domain;
        final int minutes; // 0 = no daily limit.
        final boolean bedtime;
        Site(String domain, int minutes, boolean bedtime) { this.domain = domain; this.minutes = minutes; this.bedtime = bedtime; }
    }

    boolean bedtimeOn = true;
    String from = "22:30", to = "07:00";
    private final Map<String, Site> sites = new LinkedHashMap<>();

    List<Site> sites() { return new ArrayList<>(sites.values()); }

    /** A valid "HH:mm" time, or null. */
    static String clock(String value) {
        return value != null && value.matches("([01]\\d|2[0-3]):[0-5]\\d") ? value : null;
    }

    void setBedtime(boolean on, String from, String to) {
        bedtimeOn = on;
        if (clock(from) != null) this.from = from;
        if (clock(to) != null) this.to = to;
    }

    /** Adds or replaces a site. Throws with a user-facing message for an invalid domain or a full list. */
    void put(String website, int minutes, boolean bedtime) {
        String domain = Websites.domain(website);
        if (!sites.containsKey(domain) && sites.size() >= MAX_SITES) throw new IllegalArgumentException("You can limit up to 100 websites.");
        sites.put(domain, new Site(domain, Math.max(0, Math.min(Session.MAX_MINUTES, minutes)), bedtime));
    }

    void remove(String domain) { sites.remove(domain); }

    /** Whether anything could be blocked, so Still only watches browsers when it needs to. */
    boolean active() {
        for (Site site : sites.values()) if (site.minutes > 0 || (bedtimeOn && site.bedtime)) return true;
        return false;
    }

    /** The limited site covering {@code host} (label boundaries, like blocking), or null. */
    Site find(String host) {
        if (host == null) return null;
        for (Site site : sites.values()) if (Websites.matches(host, site.domain)) return site;
        return null;
    }

    private static int minuteOf(String time) { return Integer.parseInt(time.substring(0, 2)) * 60 + Integer.parseInt(time.substring(3)); }

    /** Same rule as inBedtime in app/websites.js: the window may cross midnight; equal times mean never. */
    boolean inBedtime(int minuteOfDay) {
        int start = minuteOf(from), end = minuteOf(to);
        return start < end ? minuteOfDay >= start && minuteOfDay < end : start > end && (minuteOfDay >= start || minuteOfDay < end);
    }

    /** Why {@code site} is out of reach right now (BEDTIME or LIMIT), or null if it is available. */
    String blocked(Site site, long secondsUsed, int minuteOfDay) {
        if (site.bedtime && bedtimeOn && inBedtime(minuteOfDay)) return BEDTIME;
        if (site.minutes > 0 && secondsUsed >= site.minutes * 60L) return LIMIT;
        return null;
    }
}

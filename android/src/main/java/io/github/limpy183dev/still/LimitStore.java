package io.github.limpy183dev.still;

import android.content.Context;
import android.content.SharedPreferences;
import android.os.SystemClock;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.time.LocalDate;
import java.util.HashMap;
import java.util.Iterator;
import java.util.Map;

/**
 * Stores the limits (same JSON shape as websiteLimits in the Windows preferences) and today's usage.
 * Usage is kept in memory and written at most every 30 seconds, or when counting stops, so counting
 * costs no disk work per check. It resets at local midnight. Main thread only.
 */
final class LimitStore {
    private static final long FLUSH_MS = 30000;
    private static Limits limits;
    private static String day;
    private static final Map<String, Long> usedMs = new HashMap<>();
    private static long lastFlush;
    private static boolean dirty;

    private LimitStore() {}

    private static SharedPreferences prefs(Context c) { return c.getSharedPreferences("limits", Context.MODE_PRIVATE); }

    static Limits limits(Context c) {
        if (limits == null) limits = parse(prefs(c).getString("limits", null));
        return limits;
    }

    static void save(Context c, Limits value) {
        limits = value;
        prefs(c).edit().putString("limits", toJson(value)).apply();
        BlockService.refresh();
    }

    static long secondsUsed(Context c, String domain) {
        rollover(c);
        Long ms = usedMs.get(domain);
        return ms == null ? 0 : ms / 1000;
    }

    static void count(Context c, String domain, long ms) {
        rollover(c);
        Long old = usedMs.get(domain);
        usedMs.put(domain, (old == null ? 0 : old) + ms);
        dirty = true;
        if (SystemClock.elapsedRealtime() - lastFlush > FLUSH_MS) flush(c);
    }

    static void flush(Context c) {
        if (!dirty || day == null) return;
        dirty = false;
        lastFlush = SystemClock.elapsedRealtime();
        try {
            prefs(c).edit().putString("usage", new JSONObject().put("day", day).put("ms", new JSONObject(usedMs)).toString()).apply();
        } catch (JSONException ignored) { }
    }

    /** Loads today's usage once, and starts a fresh day at midnight. */
    private static void rollover(Context c) {
        String today = LocalDate.now().toString();
        if (day == null) {
            day = today;
            try {
                JSONObject saved = new JSONObject(prefs(c).getString("usage", "{}"));
                JSONObject ms = saved.optJSONObject("ms");
                if (today.equals(saved.optString("day")) && ms != null)
                    for (Iterator<String> keys = ms.keys(); keys.hasNext(); ) {
                        String domain = keys.next();
                        usedMs.put(domain, Math.max(0, ms.optLong(domain)));
                    }
            } catch (JSONException ignored) { } // Damaged usage only resets today's counts.
        }
        if (!today.equals(day)) {
            day = today;
            usedMs.clear();
            dirty = true;
            flush(c);
        }
    }

    /** Invalid entries are dropped, like limits() in app/websites.js; a damaged value means no limits. */
    static Limits parse(String json) {
        Limits out = new Limits();
        if (json == null) return out;
        try {
            JSONObject o = new JSONObject(json);
            JSONObject bedtime = o.optJSONObject("bedtime");
            if (bedtime != null) out.setBedtime(bedtime.optBoolean("on", true), bedtime.optString("from"), bedtime.optString("to"));
            JSONArray sites = o.optJSONArray("sites");
            if (sites != null) for (int i = 0; i < sites.length(); i++) {
                JSONObject site = sites.optJSONObject(i);
                if (site == null) continue;
                try {
                    out.put(site.optString("domain"), (int) Math.round(site.optDouble("minutes", 0)), site.optBoolean("bedtime"));
                } catch (IllegalArgumentException skipped) { }
            }
        } catch (JSONException e) {
            return new Limits();
        }
        return out;
    }

    static String toJson(Limits value) {
        try {
            JSONArray sites = new JSONArray();
            for (Limits.Site site : value.sites())
                sites.put(new JSONObject().put("domain", site.domain).put("minutes", site.minutes).put("bedtime", site.bedtime));
            return new JSONObject().put("bedtime", new JSONObject().put("on", value.bedtimeOn).put("from", value.from).put("to", value.to))
                    .put("sites", sites).toString();
        } catch (JSONException e) {
            throw new IllegalStateException(e);
        }
    }
}

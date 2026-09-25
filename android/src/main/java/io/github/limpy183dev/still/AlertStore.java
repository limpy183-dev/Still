package io.github.limpy183dev.still;

import android.app.AlarmManager;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.util.AtomicFile;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.io.FileNotFoundException;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

/**
 * Saved alerts and what they do when they come due, mirroring app/alerts-main.cjs. Main thread only.
 *
 * Event-driven: there is no polling. One exact alarm wakes Still at the next moment anything is due (a start,
 * a snooze returning, or blocking to give up on), and the same check also runs when a session ends, the
 * blocking service connects, the phone boots, the date, time or time zone changes, and Still is opened.
 *
 * alerts.json is written through AtomicFile (with a .bak until each write completes). A file that can't be
 * read is kept as alerts.corrupt.json and Still starts with no alerts rather than guessing.
 */
final class AlertStore {
    static final String ACTION = "io.github.limpy183dev.still.ALERT";
    static final String MEDIA = "alert-media";
    private static final long MEDIA_GRACE_MS = 24 * 3600_000L;
    private static List<Alerts.Alert> records;
    private static boolean ticking, again;
    static String loadError;

    private AlertStore() {}

    static List<Alerts.Alert> all(Context c) { load(c); return records; }

    static Alerts.Alert find(Context c, String id) {
        for (Alerts.Alert a : all(c)) if (a.id.equals(id)) return a;
        return null;
    }

    static File media(Context c, String file) { return new File(new File(c.getFilesDir(), MEDIA), file); }

    /** Saves a new or edited alert (as alerts:save). Nothing changes if the save fails. */
    static void save(Context c, Alerts.Alert alert) throws IOException {
        Alerts.validate(alert);
        List<Alerts.Alert> before = all(c);
        Alerts.Alert existing = alert.id == null ? null : find(c, alert.id);
        if (existing == null && before.size() >= Alerts.MAX_ALERTS) throw new IllegalArgumentException(c.getString(R.string.alerts_full));
        if (alert.enabled && "once".equals(alert.repeat)) {
            Alerts.Alert fresh = copy(alert);
            fresh.lastOccurrence = 0;
            if (Alerts.next(fresh, System.currentTimeMillis(), ZoneId.systemDefault()) == 0)
                throw new IllegalArgumentException(c.getString(R.string.alert_past));
        }
        for (String file : new String[] { alert.soundFile, alert.banner })
            if (file != null && !media(c, file).isFile()) throw new IllegalArgumentException(c.getString(R.string.alert_media_missing));
        if (existing != null) {
            alert.lastOccurrence = Alerts.scheduleChanged(existing, alert) ? 0 : existing.lastOccurrence;
            alert.snoozeCount = existing.snoozeCount;
            alert.sessionId = existing.sessionId;
            alert.lastResult = existing.lastResult;
            alert.occurrenceApps.putAll(existing.occurrenceApps);
        } else {
            alert.id = UUID.randomUUID().toString();
        }
        alert.snoozeAt = 0;
        alert.pending = 0;
        List<Alerts.Alert> next = new ArrayList<>();
        for (Alerts.Alert a : before) next.add(a == existing ? alert : a);
        if (existing == null) next.add(alert);
        commit(c, before, next);
    }

    static void toggle(Context c, String id) throws IOException {
        List<Alerts.Alert> before = all(c), next = new ArrayList<>();
        for (Alerts.Alert a : before) {
            if (!a.id.equals(id)) { next.add(a); continue; }
            Alerts.Alert changed = copy(a);
            changed.enabled = !a.enabled;
            changed.snoozeAt = 0;
            changed.pending = 0;
            next.add(changed);
        }
        commit(c, before, next);
    }

    /** A focus session this alert already started keeps running until its normal end, as on Windows. */
    static void delete(Context c, String id) throws IOException {
        List<Alerts.Alert> before = all(c), next = new ArrayList<>();
        for (Alerts.Alert a : before) if (!a.id.equals(id)) next.add(a);
        commit(c, before, next);
        AlarmActivity.closeFor(c, id);
    }

    private static void commit(Context c, List<Alerts.Alert> before, List<Alerts.Alert> next) throws IOException {
        records = next;
        try { write(c); } catch (IOException e) { records = before; throw e; }
        cleanMedia(c);
        tick(c);
    }

    /**
     * Snooze from an alarm (as alarm-action "snooze"): releases this alert's session now and rings again in
     * five minutes, restarting blocking then if the focus window still has time. The occurrence and count
     * must match what was shown, so an old notification can't snooze a later alarm.
     */
    static boolean snooze(Context c, String id, long occurrence, int count, long end) {
        Alerts.Alert a = find(c, id);
        if (a == null || !a.enabled || a.lastOccurrence != occurrence || a.snoozeCount != count || a.snoozeAt != 0 || !Alerts.canSnooze(a))
            return false;
        String session = a.sessionId;
        a.snoozeCount++;
        a.sessionId = null;
        a.pending = 0;
        a.snoozeAt = System.currentTimeMillis() + Alerts.SNOOZE_MINUTES * 60000L;
        a.snoozeEnd = end;
        a.lastResult = c.getString(a.occurrenceApps.isEmpty() ? R.string.alert_snoozed_reminder : R.string.alert_snoozed);
        writeQuietly(c);
        Session s = Store.current(c);
        if (session != null && s != null && session.equals(s.id)) Store.finish(c, "snoozed");
        tick(c);
        return true;
    }

    /** Handles whatever is due, then sets the one alarm for the next thing. Re-entrant calls run once more. */
    static void tick(Context c) {
        if (ticking) { again = true; return; }
        ticking = true;
        try {
            do { again = false; run(c); } while (again);
        } finally {
            ticking = false;
        }
        schedule(c);
    }

    private static void run(Context c) {
        ZoneId zone = ZoneId.systemDefault();
        for (Alerts.Alert a : new ArrayList<>(all(c))) {
            if (!a.enabled) continue;
            long now = System.currentTimeMillis(), showEnd = 0;
            String show = null;
            if (a.snoozeAt > 0 && a.snoozeAt <= now) {
                if (a.snoozeEnd <= now) {
                    a.lastResult = c.getString(R.string.alert_window_ended);
                    show = c.getString(R.string.alert_snooze_ended);
                } else if (!a.occurrenceApps.isEmpty()) {
                    a.pending = a.snoozeEnd;
                    a.lastResult = c.getString(R.string.alert_restarting);
                } else {
                    show = c.getString(R.string.alert_later);
                }
                a.snoozeAt = 0;
                showEnd = a.snoozeEnd;
                if (show == null) show = "";
                writeQuietly(c);
            }
            Alerts.Occurrence o = Alerts.due(a, now, zone);
            if (o != null) {
                // Claimed and saved before anything is shown or blocked, so it never happens twice.
                a.lastOccurrence = o.start;
                a.snoozeCount = 0;
                a.snoozeAt = 0;
                a.sessionId = null;
                a.pending = 0;
                a.occurrenceApps.clear();
                show = null;
                if (o.end <= now) {
                    a.lastResult = c.getString(R.string.alert_missed);
                } else {
                    a.occurrenceApps.putAll(targets(c, a));
                    a.pending = a.occurrenceApps.isEmpty() ? 0 : o.end;
                    a.lastResult = c.getString(!a.occurrenceApps.isEmpty() ? R.string.alert_waiting
                            : "current".equals(a.blockMode) ? R.string.alert_none_selected : R.string.alert_delivered);
                    show = "";
                    showEnd = o.end;
                }
                writeQuietly(c);
            }
            if (a.snoozeAt == 0 && a.pending > 0) startBlocking(c, a);
            if (show != null) AlarmActivity.present(c, a, showEnd, show.isEmpty() ? a.lastResult : show);
            else AlarmActivity.update(a.id, a.lastResult);
        }
    }

    private static void startBlocking(Context c, Alerts.Alert a) {
        String before = a.lastResult;
        String problem = Device.managedReason(c);
        if (a.pending <= System.currentTimeMillis()) {
            a.pending = 0;
            a.lastResult = c.getString(R.string.alert_too_late);
        } else if (Store.current(c) != null) {
            a.lastResult = c.getString(R.string.alert_other_session);
        } else if (problem != null) {
            a.lastResult = problem;
        } else if (!Device.blockingEnabled(c)) {
            a.lastResult = c.getString(R.string.alert_not_blocking);
        } else {
            long end = a.pending;
            // Cleared and saved first: a failure below must never replay a start later.
            a.pending = 0;
            a.lastResult = c.getString(R.string.alert_starting);
            writeQuietly(c);
            try {
                Map<String, String> apps = new LinkedHashMap<>();
                List<String> sites = new ArrayList<>();
                for (Map.Entry<String, String> t : a.occurrenceApps.entrySet()) {
                    if (Alerts.isWebsite(t.getKey())) sites.add(t.getKey().substring(Alerts.WEBSITE.length()));
                    else apps.put(t.getKey(), t.getValue());
                }
                if (!sites.isEmpty()) for (Map.Entry<String, String> browser : Device.otherBrowsers(c).entrySet())
                    apps.putIfAbsent(browser.getKey(), browser.getValue());
                Session s = Session.startUntil(UUID.randomUUID().toString(), a.title, end, a.unlockDelayMinutes,
                        c.getSharedPreferences("prefs", Context.MODE_PRIVATE).getBoolean("strict", true), apps, sites, Store.clock(c));
                try {
                    s.screen = Store.frozenScreen(c, s.websites);
                } catch (IllegalArgumentException redirectBlocked) {
                    s.screen = BlockScreen.DEFAULT; // Unattended: blocking matters more than the look.
                }
                Store.start(c, s);
                a.sessionId = s.id;
                a.lastResult = c.getResources().getQuantityString(R.plurals.alert_started, a.occurrenceApps.size(), a.occurrenceApps.size());
            } catch (IOException | RuntimeException e) {
                a.lastResult = c.getString(R.string.alert_block_failed, String.valueOf(e.getMessage()));
            }
        }
        if (!a.lastResult.equals(before)) writeQuietly(c);
    }

    /** What an occurrence blocks: nothing, the Focus space selection as it is now, or the alert's own list. */
    private static Map<String, String> targets(Context c, Alerts.Alert a) {
        Map<String, String> out = new LinkedHashMap<>();
        if ("custom".equals(a.blockMode)) out.putAll(a.apps);
        if (!"current".equals(a.blockMode)) return out;
        android.content.SharedPreferences prefs = c.getSharedPreferences("prefs", Context.MODE_PRIVATE);
        PackageManager pm = c.getPackageManager();
        for (String pkg : prefs.getStringSet("selected", new HashSet<>())) {
            try {
                out.put(pkg, String.valueOf(pm.getApplicationLabel(pm.getApplicationInfo(pkg, 0))));
            } catch (PackageManager.NameNotFoundException uninstalled) { }
        }
        for (String site : prefs.getString("websites", "").split("\n"))
            if (!site.isEmpty()) out.put(Alerts.WEBSITE + site, site);
        return out;
    }

    /** One exact alarm for the earliest thing due. No alerts means no alarm at all. */
    private static void schedule(Context c) {
        c = c.getApplicationContext();
        long now = System.currentTimeMillis(), wake = Long.MAX_VALUE;
        ZoneId zone = ZoneId.systemDefault();
        for (Alerts.Alert a : all(c)) wake = Math.min(wake, Alerts.wake(a, now, zone));
        AlarmManager alarms = c.getSystemService(AlarmManager.class);
        PendingIntent pi = PendingIntent.getBroadcast(c, 1, new Intent(c, Events.class).setAction(ACTION),
                PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        if (wake == Long.MAX_VALUE) { alarms.cancel(pi); return; }
        wake = Math.max(wake, now + 1000);
        // Android 11 needs no permission; USE_EXACT_ALARM (13+) and SCHEDULE_EXACT_ALARM (12) are granted at install.
        // Fall back to an inexact alarm if one is revoked.
        if (android.os.Build.VERSION.SDK_INT < android.os.Build.VERSION_CODES.S || alarms.canScheduleExactAlarms()) alarms.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, wake, pi);
        else alarms.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, wake, pi);
    }

    /** Deletes copied sounds and banners no alert uses. Fresh picks get a day's grace for an unsaved editor. */
    private static void cleanMedia(Context c) {
        Set<String> used = new HashSet<>();
        for (Alerts.Alert a : all(c)) { used.add(a.soundFile); used.add(a.banner); }
        File[] files = new File(c.getFilesDir(), MEDIA).listFiles();
        if (files != null) for (File f : files)
            if (!used.contains(f.getName()) && f.lastModified() < System.currentTimeMillis() - MEDIA_GRACE_MS) f.delete();
    }

    static int noticeId(String id) { return 1000 + (id.hashCode() & 0xFFFF); }

    // --- Storage ---

    private static AtomicFile file(Context c) { return new AtomicFile(new File(c.getFilesDir(), "alerts.json")); }

    private static void load(Context c) {
        if (records != null) return;
        records = new ArrayList<>();
        AtomicFile file = file(c);
        try {
            JSONArray saved = new JSONArray(new String(file.readFully(), StandardCharsets.UTF_8));
            for (int i = 0; i < saved.length() && records.size() < Alerts.MAX_ALERTS; i++) records.add(fromJson(saved.getJSONObject(i)));
        } catch (FileNotFoundException firstRun) {
            // No alerts yet.
        } catch (IOException | JSONException | RuntimeException e) {
            loadError = e.getMessage();
            records = new ArrayList<>();
            try (FileOutputStream copy = new FileOutputStream(new File(c.getFilesDir(), "alerts.corrupt.json"))) {
                copy.write(file.readFully());
            } catch (IOException | RuntimeException ignored) { }
        }
    }

    private static void writeQuietly(Context c) {
        // The in-memory state still applies; a full disk must not stop an alarm from ringing.
        try { write(c); } catch (IOException ignored) { }
    }

    private static void write(Context c) throws IOException {
        AtomicFile file = file(c);
        FileOutputStream out = file.startWrite();
        try {
            JSONArray all = new JSONArray();
            for (Alerts.Alert a : records) all.put(toJson(a));
            out.write(all.toString().getBytes(StandardCharsets.UTF_8));
            file.finishWrite(out);
        } catch (IOException | JSONException | RuntimeException e) {
            file.failWrite(out);
            throw e instanceof IOException ? (IOException) e : new IOException(e);
        }
    }

    static Alerts.Alert copy(Alerts.Alert a) {
        try { return fromJson(toJson(a)); } catch (JSONException e) { throw new IllegalStateException(e); }
    }

    /** The same keys as a Windows alerts.json record, with {path, name} targets and {file, name} media. */
    static JSONObject toJson(Alerts.Alert a) throws JSONException {
        // A new alert has no id until it is saved.
        JSONObject o = new JSONObject().put("id", a.id == null ? "" : a.id).put("title", a.title).put("note", a.note).put("date", a.date)
                .put("time", a.time).put("repeat", a.repeat).put("lengthMode", a.lengthMode)
                .put("durationMinutes", a.durationMinutes).put("endTime", a.endTime).put("style", a.style)
                .put("snoozeLimit", a.snoozeLimit == null ? JSONObject.NULL : a.snoozeLimit).put("showDismiss", a.showDismiss)
                .put("blockMode", a.blockMode).put("apps", targets(a.apps)).put("unlockDelayMinutes", a.unlockDelayMinutes)
                .put("sound", a.sound).put("volume", a.volume).put("soundFile", media(a.soundFile, a.soundName))
                .put("banner", media(a.banner, a.bannerName)).put("enabled", a.enabled)
                .put("lastOccurrence", a.lastOccurrence).put("snoozeCount", a.snoozeCount).put("snoozeAt", a.snoozeAt)
                .put("snoozeEnd", a.snoozeEnd).put("pendingEnd", a.pending).put("lastResult", a.lastResult)
                .put("occurrenceApps", targets(a.occurrenceApps));
        if (a.sessionId != null) o.put("sessionId", a.sessionId);
        return o;
    }

    private static JSONArray targets(Map<String, String> apps) throws JSONException {
        JSONArray out = new JSONArray();
        for (Map.Entry<String, String> app : apps.entrySet()) out.put(new JSONObject().put("path", app.getKey()).put("name", app.getValue()));
        return out;
    }

    private static Object media(String file, String name) throws JSONException {
        return file == null ? JSONObject.NULL : new JSONObject().put("file", file).put("name", name == null ? file : name);
    }

    static Alerts.Alert fromJson(JSONObject o) throws JSONException {
        Alerts.Alert a = new Alerts.Alert();
        a.id = o.getString("id");
        a.title = o.getString("title");
        a.note = o.optString("note");
        a.date = o.getString("date");
        a.time = o.getString("time");
        a.repeat = o.getString("repeat");
        a.lengthMode = o.getString("lengthMode");
        a.durationMinutes = o.getInt("durationMinutes");
        a.endTime = o.getString("endTime");
        a.style = o.getString("style");
        a.snoozeLimit = o.isNull("snoozeLimit") ? null : o.getInt("snoozeLimit");
        a.showDismiss = o.optBoolean("showDismiss", true);
        a.blockMode = o.getString("blockMode");
        readTargets(o.optJSONArray("apps"), a.apps);
        a.unlockDelayMinutes = o.getInt("unlockDelayMinutes");
        a.sound = o.getString("sound");
        a.volume = o.getInt("volume");
        JSONObject sound = o.optJSONObject("soundFile"), banner = o.optJSONObject("banner");
        if (sound != null) { a.soundFile = sound.getString("file"); a.soundName = sound.optString("name"); }
        if (banner != null) { a.banner = banner.getString("file"); a.bannerName = banner.optString("name"); }
        a.enabled = o.optBoolean("enabled", true);
        a.lastOccurrence = o.optLong("lastOccurrence");
        a.snoozeCount = o.optInt("snoozeCount");
        a.snoozeAt = o.optLong("snoozeAt");
        a.snoozeEnd = o.optLong("snoozeEnd");
        a.pending = o.optLong("pendingEnd");
        a.sessionId = o.has("sessionId") ? o.getString("sessionId") : null;
        a.lastResult = o.optString("lastResult");
        readTargets(o.optJSONArray("occurrenceApps"), a.occurrenceApps);
        // Stored alerts are re-checked, so a hand-edited file can't create an invalid alert.
        try {
            Alerts.validate(a);
        } catch (IllegalArgumentException e) {
            throw new JSONException(e.getMessage());
        }
        return a;
    }

    private static void readTargets(JSONArray list, Map<String, String> out) throws JSONException {
        if (list != null) for (int i = 0; i < list.length(); i++) {
            JSONObject t = list.getJSONObject(i);
            out.put(t.getString("path"), t.optString("name"));
        }
    }

    static void cancelNotice(Context c, String id) {
        c.getSystemService(NotificationManager.class).cancel(noticeId(id));
    }
}

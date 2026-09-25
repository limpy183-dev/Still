package io.github.limpy183dev.still;

import android.app.AlarmManager;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.os.SystemClock;
import android.provider.Settings;
import android.text.format.DateFormat;
import android.util.AtomicFile;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.io.FileNotFoundException;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.time.LocalDate;
import java.time.LocalTime;
import java.time.ZoneId;
import java.util.Iterator;

/**
 * The session state and its side effects. All calls happen on the main thread.
 *
 * state.json is written through AtomicFile, which keeps state.json.bak until a write completes and
 * restores it on the next read, so a crash or power loss mid-write never loses the session. A file that
 * still cannot be read is copied to state.corrupt.json and Still starts with nothing blocked (fail open).
 */
final class Store {
    private static final int HISTORY_LIMIT = 500, NOTICE_SESSION = 1, NOTICE_DONE = 2;
    /** The running session's copy of a custom block-screen image. */
    static final String SESSION_IMAGE = "session-screen.webp";
    private static boolean loaded;
    private static Session session;
    private static JSONArray history = new JSONArray();
    static String loadError;

    private Store() {}

    static Session.Clock clock(Context c) {
        return new Session.Clock(System.currentTimeMillis(), SystemClock.elapsedRealtime(),
                Settings.Global.getInt(c.getContentResolver(), Settings.Global.BOOT_COUNT, -1));
    }

    /** The running session, or null. An expired session is finished here, so every caller sees expiry. */
    static Session current(Context c) {
        load(c);
        if (session != null && session.expired(clock(c))) finish(c, "completed");
        return session;
    }

    static JSONArray history(Context c) { load(c); return history; }

    /** Saved sessions, newest first, plus the running one (without an outcome) for the progress figures. */
    static java.util.List<History.Record> records(Context c) {
        Session running = current(c);
        java.util.List<History.Record> out = new java.util.ArrayList<>();
        if (running != null) try { out.add(record(toJson(running))); } catch (JSONException ignored) { }
        for (int i = 0; i < history.length(); i++) {
            JSONObject o = history.optJSONObject(i);
            if (o != null && o.optString("id").length() > 0) out.add(record(o));
        }
        return out;
    }

    private static History.Record record(JSONObject o) {
        History.Record r = new History.Record();
        r.id = o.optString("id");
        r.intention = o.optString("intention");
        r.outcome = o.has("outcome") ? o.optString("outcome") : null;
        r.startedAt = o.optLong("startedAt");
        r.endsAt = o.optLong("endsAt");
        r.finishedAt = o.optLong("finishedAt");
        r.archived = o.optBoolean("archived");
        JSONObject apps = o.optJSONObject("apps");
        JSONArray sites = o.optJSONArray("websites");
        r.targets = (apps == null ? 0 : apps.length()) + (sites == null ? 0 : sites.length());
        return r;
    }

    /** Archive, restore or delete a saved session (as updateHistory on Windows). Nothing changes if the save fails. */
    static void updateHistory(Context c, String id, String action) throws IOException {
        load(c);
        if (!"archive".equals(action) && !"restore".equals(action) && !"delete".equals(action))
            throw new IllegalArgumentException("Invalid history action.");
        JSONArray before = history, next = new JSONArray();
        try {
            for (int i = 0; i < before.length(); i++) {
                JSONObject o = before.getJSONObject(i);
                if (!id.equals(o.optString("id"))) next.put(o);
                else if (!"delete".equals(action)) next.put(new JSONObject(o.toString()).put("archived", "archive".equals(action)));
            }
        } catch (JSONException e) {
            throw new IOException(e);
        }
        history = next;
        try { save(c); } catch (IOException e) { history = before; throw e; }
    }

    static void start(Context c, Session s) throws IOException {
        if (current(c) != null) throw new IllegalStateException("A focus session is already running.");
        session = s;
        try { save(c); } catch (IOException e) { session = null; throw e; }
        changed(c);
    }

    /** Persists a change to the running session (release request or cancel). */
    static void update(Context c) throws IOException {
        save(c);
        changed(c);
    }

    static void finish(Context c, String outcome) {
        load(c);
        if (session == null) return;
        Session s = session;
        session = null;
        s.outcome = outcome;
        s.finishedAt = System.currentTimeMillis();
        // Artwork belongs to the running session, not every history record (as on Windows).
        s.screen = BlockScreen.DEFAULT;
        new File(c.getFilesDir(), SESSION_IMAGE).delete();
        try {
            JSONArray next = new JSONArray().put(toJson(s));
            for (int i = 0; i < history.length() && next.length() < HISTORY_LIMIT; i++) next.put(history.get(i));
            history = next;
        } catch (JSONException ignored) { }
        // A full disk must not keep apps blocked: the in-memory session is already released.
        try { save(c); } catch (IOException ignored) { }
        changed(c);
        if ("completed".equals(outcome)) notice(c, NOTICE_DONE, "done", NotificationManager.IMPORTANCE_DEFAULT,
                new Notification.Builder(c, "done").setContentTitle(c.getString(R.string.done_title))
                        .setContentText(c.getString(R.string.done_text)).setAutoCancel(true));
        AlertStore.tick(c); // An alert waiting for this session to end may start blocking now.
    }

    /**
     * The saved block screen, re-checked against the session's websites and frozen into it with a copy of its
     * image, so changing it later can't change a running session (as on Windows). Without the image, the text
     * still shows.
     */
    static BlockScreen frozenScreen(Context c, java.util.Collection<String> sites) {
        BlockScreen saved = BlockScreenActivity.saved(c);
        BlockScreen screen = BlockScreen.of(saved.mode, saved.title, saved.text, saved.redirect, saved.image, sites);
        if (!screen.image) return screen;
        try {
            java.nio.file.Files.copy(new File(c.getFilesDir(), BlockScreenActivity.IMAGE).toPath(),
                    new File(c.getFilesDir(), SESSION_IMAGE).toPath(), java.nio.file.StandardCopyOption.REPLACE_EXISTING);
            return screen;
        } catch (IOException | RuntimeException e) {
            return BlockScreen.of(screen.mode, screen.title, screen.text, screen.redirect, false, new java.util.ArrayList<>());
        }
    }

    /** Re-reads the clocks after the date or time changed or the phone rebooted. */
    static void reanchor(Context c) {
        Session s = current(c);
        if (s != null && s.anchor(clock(c))) {
            try { save(c); } catch (IOException ignored) { }
        }
        changed(c);
    }

    /** Brings the alarm, the ongoing notification and the blocker in line with the state. */
    static void changed(Context c) {
        c = c.getApplicationContext();
        AlarmManager alarms = c.getSystemService(AlarmManager.class);
        PendingIntent tick = PendingIntent.getBroadcast(c, 0, new Intent(c, Events.class),
                PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        Session.Clock now = clock(c);
        if (session == null) {
            alarms.cancel(tick);
            c.getSystemService(NotificationManager.class).cancel(NOTICE_SESSION);
        } else {
            // Inexact on purpose (no exact-alarm permission, fewer wakeups). Blocking itself checks the clock
            // on every window change, so apps are released on time even if this alarm is late.
            long left = Math.max(0, session.remaining(now));
            alarms.setAndAllowWhileIdle(AlarmManager.ELAPSED_REALTIME_WAKEUP, now.elapsed + left, tick);
            long endsAt = now.wall + left;
            // The system UI draws the countdown, so Still does no per-second work.
            notice(c, NOTICE_SESSION, "session", NotificationManager.IMPORTANCE_LOW,
                    new Notification.Builder(c, "session").setContentTitle(session.intention)
                            .setContentText(c.getString(R.string.notice_until, time(c, endsAt)))
                            .setWhen(endsAt).setShowWhen(true).setUsesChronometer(true).setChronometerCountDown(true)
                            .setOngoing(true).setOnlyAlertOnce(true).setCategory(Notification.CATEGORY_STATUS));
        }
        BlockService.refresh();
    }

    static String time(Context c, long at) { return DateFormat.getTimeFormat(c).format(at); }

    /** An "HH:mm" setting shown in the phone's own time format. */
    static String clockText(Context c, String time) {
        return time(c, LocalDate.now().atTime(LocalTime.parse(time)).atZone(ZoneId.systemDefault()).toInstant().toEpochMilli());
    }

    private static void notice(Context c, int id, String channel, int importance, Notification.Builder builder) {
        NotificationManager manager = c.getSystemService(NotificationManager.class);
        manager.createNotificationChannel(new NotificationChannel(channel,
                c.getString("done".equals(channel) ? R.string.channel_done : R.string.channel_session), importance));
        builder.setSmallIcon(R.drawable.ic_stat).setContentIntent(PendingIntent.getActivity(c, 0,
                new Intent(c, MainActivity.class), PendingIntent.FLAG_IMMUTABLE));
        manager.notify(id, builder.build());
    }

    private static AtomicFile file(Context c) { return new AtomicFile(new File(c.getFilesDir(), "state.json")); }

    private static void load(Context c) {
        if (loaded) return;
        loaded = true;
        AtomicFile file = file(c);
        try {
            JSONObject state = new JSONObject(new String(file.readFully(), StandardCharsets.UTF_8));
            JSONArray saved = state.optJSONArray("history");
            if (saved != null) history = saved;
            JSONObject s = state.optJSONObject("session");
            if (s != null) session = fromJson(s);
        } catch (FileNotFoundException firstRun) {
            return;
        } catch (IOException | JSONException | RuntimeException e) {
            loadError = e.getMessage();
            session = null;
            history = new JSONArray();
            try (FileOutputStream copy = new FileOutputStream(new File(c.getFilesDir(), "state.corrupt.json"))) {
                copy.write(file.readFully());
            } catch (IOException | RuntimeException ignored) { }
            return;
        }
        if (session != null && session.anchor(clock(c))) {
            try { save(c); } catch (IOException ignored) { }
        }
    }

    private static void save(Context c) throws IOException {
        AtomicFile file = file(c);
        FileOutputStream out = file.startWrite();
        try {
            JSONObject state = new JSONObject().put("version", 1).put("history", history);
            if (session != null) state.put("session", toJson(session));
            out.write(state.toString().getBytes(StandardCharsets.UTF_8));
            file.finishWrite(out);
        } catch (IOException | JSONException | RuntimeException e) {
            file.failWrite(out);
            throw e instanceof IOException ? (IOException) e : new IOException(e);
        }
    }

    private static JSONObject toJson(Session s) throws JSONException {
        JSONObject apps = new JSONObject();
        for (java.util.Map.Entry<String, String> app : s.apps.entrySet()) apps.put(app.getKey(), app.getValue());
        JSONObject o = new JSONObject().put("id", s.id).put("intention", s.intention).put("apps", apps)
                .put("websites", new JSONArray(s.websites))
                .put("screen", new JSONObject().put("mode", s.screen.mode).put("title", s.screen.title)
                        .put("text", s.screen.text).put("redirect", s.screen.redirect).put("image", s.screen.image))
                .put("startedAt", s.startedAt).put("endsAt", s.endsAt).put("durationMinutes", s.durationMinutes)
                .put("unlockDelayMinutes", s.unlockDelayMinutes).put("unlockAt", s.unlockAt).put("strict", s.strict)
                .put("boot", s.boot).put("endsElapsed", s.endsElapsed).put("unlockElapsed", s.unlockElapsed)
                .put("scheduledEndsAt", s.scheduledEndsAt);
        if (s.outcome != null) o.put("outcome", s.outcome).put("finishedAt", s.finishedAt);
        return o;
    }

    private static Session fromJson(JSONObject o) throws JSONException {
        Session s = new Session();
        s.id = o.getString("id");
        s.intention = o.getString("intention");
        s.startedAt = o.getLong("startedAt");
        s.endsAt = o.getLong("endsAt");
        s.durationMinutes = o.getInt("durationMinutes");
        s.unlockDelayMinutes = o.getInt("unlockDelayMinutes");
        s.unlockAt = o.optLong("unlockAt");
        s.strict = o.optBoolean("strict");
        s.boot = o.optInt("boot", -1);
        s.endsElapsed = o.optLong("endsElapsed");
        s.unlockElapsed = o.optLong("unlockElapsed");
        s.scheduledEndsAt = o.optLong("scheduledEndsAt");
        if (s.scheduledEndsAt != 0 && (s.length() <= 0 || s.length() > Session.MAX_SCHEDULED_MS))
            throw new JSONException("Invalid scheduled end.");
        JSONObject apps = o.getJSONObject("apps");
        for (Iterator<String> keys = apps.keys(); keys.hasNext(); ) {
            String pkg = keys.next();
            s.apps.put(pkg, apps.getString(pkg));
        }
        JSONArray sites = o.optJSONArray("websites"); // Absent in stage-one files.
        if (sites != null) for (int i = 0; i < sites.length(); i++) s.websites.add(Websites.domain(sites.getString(i)));
        // Stored limits are re-checked: a hand-edited file cannot create an over-long or empty session.
        Session.validate(s.durationMinutes, s.unlockDelayMinutes, s.apps.size() + s.websites.size());
        JSONObject screen = o.optJSONObject("screen"); // Absent in older files: Quiet garden.
        if (screen != null) try {
            s.screen = BlockScreen.of(screen.optString("mode"), screen.optString("title"), screen.optString("text"),
                    screen.optString("redirect"), screen.optBoolean("image"), s.websites);
        } catch (IllegalArgumentException damaged) {
            s.screen = BlockScreen.DEFAULT; // Only the look is lost; blocking is unaffected.
        }
        return s;
    }
}

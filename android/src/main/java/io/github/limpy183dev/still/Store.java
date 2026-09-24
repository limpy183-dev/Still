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
                .put("startedAt", s.startedAt).put("endsAt", s.endsAt).put("durationMinutes", s.durationMinutes)
                .put("unlockDelayMinutes", s.unlockDelayMinutes).put("unlockAt", s.unlockAt).put("strict", s.strict)
                .put("boot", s.boot).put("endsElapsed", s.endsElapsed).put("unlockElapsed", s.unlockElapsed);
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
        JSONObject apps = o.getJSONObject("apps");
        for (Iterator<String> keys = apps.keys(); keys.hasNext(); ) {
            String pkg = keys.next();
            s.apps.put(pkg, apps.getString(pkg));
        }
        // Stored limits are re-checked: a hand-edited file cannot create an over-long or empty session.
        Session.validate(s.durationMinutes, s.unlockDelayMinutes, s.apps.size());
        return s;
    }
}

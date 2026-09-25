package io.github.limpy183dev.still;

import android.app.Activity;
import android.app.KeyguardManager;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.graphics.ImageDecoder;
import android.graphics.drawable.AnimatedImageDrawable;
import android.graphics.drawable.Drawable;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.TextView;
import android.widget.VideoView;
import android.window.OnBackInvokedDispatcher;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.io.IOException;

/**
 * An alarm on screen (as app/alarm.html): "Full attention" fills the screen, "Focus card" floats at the bottom
 * (the Card subclass, with a floating theme). Both show over the lock screen and turn the screen on. A
 * "Quiet reminder" is only a notification.
 *
 * Android opens alarm screens through a full-screen notification: over the lock screen or with the screen
 * off it opens at once; while the phone is in use Android may show it as a heads-up notification instead,
 * which opens the screen when tapped. The notification carries Snooze and Dismiss too. The screen closes
 * itself after five minutes, like on Windows, and the sound stops after one.
 */
public class AlarmActivity extends Activity {
    /** A floating card at the bottom of the screen instead of a full screen. */
    public static final class Card extends AlarmActivity { }

    /** Snooze and Dismiss from the notification. Not exported: only Still's own notifications can send these. */
    public static final class Actions extends BroadcastReceiver {
        @Override
        public void onReceive(Context c, Intent intent) {
            String id = intent.getStringExtra(ID);
            if (id == null) return;
            if ("snooze".equals(intent.getAction()))
                AlertStore.snooze(c, id, intent.getLongExtra(OCCURRENCE, -1), intent.getIntExtra(COUNT, -1), intent.getLongExtra(END, 0));
            closeFor(c, id);
        }
    }

    private static final String ID = "id", END = "end", MESSAGE = "message", OCCURRENCE = "occurrence", COUNT = "count",
            PREVIEW = "preview";
    private static final long SHOWN_MS = 5 * 60_000;
    private static AlarmActivity shown;
    private static String sounding;
    /** The alarm screen that is ringing, so blocking can bring it back after sending a blocked app home. */
    static Intent ringing;

    private final Handler handler = new Handler(Looper.getMainLooper());
    private final Runnable timeout = this::close;
    private Alerts.Alert alert;
    private boolean preview;
    private long end;

    // --- Presenting ---

    /** Rings an alert: its notification, and for alarm styles the sound and the screen. */
    static void present(Context c, Alerts.Alert a, long end, String message) {
        c = c.getApplicationContext();
        NotificationManager manager = c.getSystemService(NotificationManager.class);
        channels(c, manager);
        boolean quiet = "notification".equals(a.style);
        int id = AlertStore.noticeId(a.id);
        Intent screen = intent(c, a, end, message);
        PendingIntent open = PendingIntent.getActivity(c, id, screen, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        String text = quiet && !a.note.isEmpty() ? a.note + "\n" + message : message;
        Notification.Builder b = new Notification.Builder(c, quiet ? ("silent".equals(a.sound) || a.volume == 0 ? "reminders_quiet" : "reminders") : "alarms")
                .setSmallIcon(R.drawable.ic_stat).setContentTitle(a.title).setContentText(text)
                .setStyle(new Notification.BigTextStyle().bigText(text))
                .setCategory(quiet ? Notification.CATEGORY_REMINDER : Notification.CATEGORY_ALARM);
        if (quiet) {
            b.setAutoCancel(true).setContentIntent(PendingIntent.getActivity(c, 0, new Intent(c, MainActivity.class), PendingIntent.FLAG_IMMUTABLE));
        } else {
            b.setContentIntent(open).setFullScreenIntent(open, true).setOngoing(true).setTimeoutAfter(SHOWN_MS);
        }
        if (Alerts.canSnooze(a)) b.addAction(new Notification.Action.Builder(null, c.getString(R.string.alarm_snooze), action(c, a, "snooze", end)).build());
        if (!quiet && a.showDismiss) b.addAction(new Notification.Action.Builder(null, c.getString(R.string.alarm_dismiss), action(c, a, "dismiss", end)).build());
        manager.notify(id, b.build());
        if (quiet) return; // The notification channel plays the phone's notification sound.
        AlarmSound.play(c, a);
        sounding = a.id;
        ringing = screen.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            c.startActivity(screen); // Allowed while blocking is on; otherwise the notification opens it.
        } catch (RuntimeException ignored) { }
    }

    /** Shows an unsaved alert as it will look, with its sound. Nothing is saved, snoozed or blocked. */
    static void preview(Context c, Alerts.Alert a) throws JSONException {
        Alerts.Alert copy = AlertStore.fromJson(AlertStore.toJson(a).put("id", "preview"));
        AlarmSound.play(c, copy);
        sounding = "preview";
        long end = System.currentTimeMillis() + a.durationMinutes * 60000L;
        c.startActivity(new Intent(c, "card".equals(a.style) ? Card.class : AlarmActivity.class)
                .putExtra(PREVIEW, AlertStore.toJson(copy).toString()).putExtra(END, end)
                .putExtra(MESSAGE, c.getString(R.string.alarm_preview_message)));
    }

    /** New status for a showing alarm, e.g. once blocking has started. */
    static void update(String id, String message) {
        AlarmActivity a = shown;
        if (a != null && !a.preview && a.alert.id.equals(id)) ((TextView) a.findViewById(R.id.alarm_message)).setText(message);
    }

    /** Stops the sound and removes the notification and screen for an alert. */
    static void closeFor(Context c, String id) {
        if (id.equals(sounding)) { AlarmSound.stop(); sounding = null; }
        if (ringing != null && id.equals(ringing.getStringExtra(ID))) ringing = null;
        AlertStore.cancelNotice(c, id);
        AlarmActivity a = shown;
        if (a != null && a.alert.id.equals(id)) a.finish();
    }

    private static Intent intent(Context c, Alerts.Alert a, long end, String message) {
        return new Intent(c, "card".equals(a.style) ? Card.class : AlarmActivity.class).setData(Uri.fromParts("still-alert", a.id, null))
                .putExtra(ID, a.id).putExtra(END, end).putExtra(MESSAGE, message)
                .putExtra(OCCURRENCE, a.lastOccurrence).putExtra(COUNT, a.snoozeCount);
    }

    private static PendingIntent action(Context c, Alerts.Alert a, String name, long end) {
        Intent i = new Intent(c, Actions.class).setAction(name).setData(Uri.fromParts("still-alert", a.id, null))
                .putExtra(ID, a.id).putExtra(END, end).putExtra(OCCURRENCE, a.lastOccurrence).putExtra(COUNT, a.snoozeCount);
        return PendingIntent.getBroadcast(c, 0, i, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    private static void channels(Context c, NotificationManager manager) {
        // Alarm screens play their own sound, so their channel is silent. Reminders use the phone's sound.
        NotificationChannel alarms = new NotificationChannel("alarms", c.getString(R.string.channel_alarms), NotificationManager.IMPORTANCE_HIGH);
        alarms.setSound(null, null);
        NotificationChannel quiet = new NotificationChannel("reminders_quiet", c.getString(R.string.channel_reminders_quiet), NotificationManager.IMPORTANCE_HIGH);
        quiet.setSound(null, null);
        manager.createNotificationChannel(alarms);
        manager.createNotificationChannel(quiet);
        manager.createNotificationChannel(new NotificationChannel("reminders", c.getString(R.string.channel_reminders), NotificationManager.IMPORTANCE_HIGH));
    }

    // --- The screen ---

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        setShowWhenLocked(true);
        setTurnScreenOn(true);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        setContentView(R.layout.activity_alarm);
        if (this instanceof Card) {
            getWindow().setLayout(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
            getWindow().setGravity(Gravity.BOTTOM);
            setFinishOnTouchOutside(false);
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU)
            getOnBackInvokedDispatcher().registerOnBackInvokedCallback(OnBackInvokedDispatcher.PRIORITY_DEFAULT, this::back);
        findViewById(R.id.alarm_open).setOnClickListener(v -> {
            getSystemService(KeyguardManager.class).requestDismissKeyguard(this, null);
            startActivity(new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
            close();
        });
        findViewById(R.id.alarm_snooze).setOnClickListener(v -> {
            if (!AlertStore.snooze(this, alert.id, getIntent().getLongExtra(OCCURRENCE, -1), getIntent().getIntExtra(COUNT, -1), end))
                ((TextView) findViewById(R.id.alarm_error)).setText(R.string.alarm_snooze_gone);
            else close();
        });
        findViewById(R.id.alarm_dismiss).setOnClickListener(v -> close());
        show(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        show(intent);
    }

    @Override
    @SuppressWarnings("deprecation")
    @android.annotation.SuppressLint("GestureBackNavigation") // Only reached on Android 12 and older.
    public void onBackPressed() { back(); } // Android 12 and older.

    /** Back dismisses, unless this alarm hides Dismiss. */
    private void back() {
        if (findViewById(R.id.alarm_dismiss).getVisibility() == View.VISIBLE) close();
    }

    @Override
    protected void onDestroy() {
        handler.removeCallbacksAndMessages(null);
        if (shown == this) shown = null;
        super.onDestroy();
    }

    private void close() {
        if (alert != null) {
            if (alert.id.equals(sounding)) { AlarmSound.stop(); sounding = null; }
            if (ringing != null && alert.id.equals(ringing.getStringExtra(ID))) ringing = null;
            if (!preview) AlertStore.cancelNotice(this, alert.id);
        }
        finish();
    }

    private void show(Intent intent) {
        String json = intent.getStringExtra(PREVIEW);
        preview = json != null;
        try {
            alert = preview ? AlertStore.fromJson(new JSONObject(json)) : AlertStore.find(this, intent.getStringExtra(ID));
        } catch (JSONException e) {
            alert = null;
        }
        if (alert == null) { finish(); return; } // Deleted meanwhile.
        shown = this;
        end = intent.getLongExtra(END, 0);
        boolean ended = end <= System.currentTimeMillis();
        text(R.id.alarm_eyebrow, getString(preview ? R.string.alarm_eyebrow_preview : R.string.alarm_eyebrow));
        text(R.id.alarm_title, alert.title);
        text(R.id.alarm_note, alert.note);
        findViewById(R.id.alarm_note).setVisibility(alert.note.isEmpty() ? View.GONE : View.VISIBLE);
        text(R.id.alarm_time, ended ? getString(R.string.alarm_ended) : getString(R.string.until, Store.time(this, end)));
        text(R.id.alarm_message, intent.getStringExtra(MESSAGE));
        text(R.id.alarm_error, "");
        findViewById(R.id.alarm_snooze).setVisibility(!preview && Alerts.canSnooze(alert) ? View.VISIBLE : View.GONE);
        findViewById(R.id.alarm_dismiss).setVisibility(preview || alert.showDismiss ? View.VISIBLE : View.GONE);
        boolean blocks = !"none".equals(alert.blockMode);
        findViewById(R.id.alarm_footnote).setVisibility(blocks ? View.VISIBLE : View.GONE);
        text(R.id.alarm_footnote, getString(!preview && end <= System.currentTimeMillis() + Alerts.SNOOZE_MINUTES * 60000L
                ? R.string.alarm_footnote_late : preview || alert.showDismiss ? R.string.alarm_footnote : R.string.alarm_footnote_no_dismiss));
        banner();
        handler.removeCallbacks(timeout);
        handler.postDelayed(timeout, SHOWN_MS);
    }

    private void text(int id, CharSequence value) { ((TextView) findViewById(id)).setText(value); }

    /** The banner: an image, an animated GIF/WebP, or a muted looping video. */
    private void banner() {
        FrameLayout box = findViewById(R.id.alarm_media);
        box.removeAllViews();
        box.setVisibility(View.GONE);
        findViewById(R.id.alarm_orbit).setVisibility(View.VISIBLE);
        if (alert.banner == null) return;
        File file = AlertStore.media(this, alert.banner);
        View media;
        if (alert.banner.matches(".*\\.(mp4|mov|webm)")) {
            VideoView video = new VideoView(this);
            video.setVideoPath(file.getPath());
            video.setOnPreparedListener(player -> { player.setLooping(true); player.setVolume(0, 0); video.start(); });
            video.setOnErrorListener((player, what, extra) -> { bannerFailed(); return true; });
            media = video;
        } else {
            int width = getResources().getDisplayMetrics().widthPixels;
            try {
                Drawable image = ImageDecoder.decodeDrawable(ImageDecoder.createSource(file), (decoder, info, source) -> {
                    // Decoded no wider than the screen, so a huge photo can't use a lot of memory.
                    int scale = Math.max(1, info.getSize().getWidth() / width);
                    decoder.setTargetSampleSize(scale);
                });
                ImageView view = new ImageView(this);
                view.setScaleType(ImageView.ScaleType.CENTER_CROP);
                view.setImageDrawable(image);
                if (image instanceof AnimatedImageDrawable) ((AnimatedImageDrawable) image).start();
                media = view;
            } catch (IOException | RuntimeException e) {
                bannerFailed();
                return;
            }
        }
        media.setContentDescription(getString(R.string.alarm_banner));
        box.addView(media, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT, Gravity.CENTER));
        box.setVisibility(View.VISIBLE);
        findViewById(R.id.alarm_orbit).setVisibility(View.GONE);
    }

    private void bannerFailed() {
        ((FrameLayout) findViewById(R.id.alarm_media)).removeAllViews();
        findViewById(R.id.alarm_media).setVisibility(View.GONE);
        findViewById(R.id.alarm_orbit).setVisibility(View.VISIBLE);
        text(R.id.alarm_error, getString(R.string.alarm_banner_failed));
    }
}

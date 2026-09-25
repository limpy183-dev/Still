package io.github.limpy183dev.still;

import android.Manifest;
import android.app.Activity;
import android.app.NotificationManager;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.Switch;
import android.widget.TextView;
import android.widget.Toast;

import java.io.IOException;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.time.format.FormatStyle;
import java.util.ArrayList;
import java.util.List;

/** The alerts list (as the Windows Alerts page): what's next, each alert's state, and what happened last. */
public final class AlertsActivity extends Activity {
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final Runnable render = this::render;
    private float dp;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        setContentView(R.layout.activity_alerts);
        dp = getResources().getDisplayMetrics().density;
        findViewById(R.id.alert_add).setOnClickListener(v -> startActivity(new Intent(this, AlertEditActivity.class)));
        Nav.attach(this, Nav.ALERTS);
    }

    @Override
    protected void onResume() {
        super.onResume();
        AlertStore.tick(this);
        render();
    }

    @Override
    protected void onPause() {
        super.onPause();
        handler.removeCallbacks(render);
    }

    private void render() {
        handler.removeCallbacks(render);
        long now = System.currentTimeMillis();
        ZoneId zone = ZoneId.systemDefault();
        Session running = Store.current(this);
        List<Alerts.Alert> all = new ArrayList<>(AlertStore.all(this));
        all.sort((a, b) -> Long.compare(nextAt(a, now, zone), nextAt(b, now, zone)));

        Alerts.Alert next = all.isEmpty() || nextAt(all.get(0), now, zone) == Long.MAX_VALUE ? null : all.get(0);
        ((TextView) findViewById(R.id.alert_next_title)).setText(next == null ? getString(R.string.alerts_next_none) : next.title);
        ((TextView) findViewById(R.id.alert_next_detail)).setText(next == null ? getString(R.string.alerts_next_none_detail)
                : getString(next.snoozeAt > 0 ? R.string.alerts_next_snoozed : R.string.alerts_next_at, when(nextAt(next, now, zone)),
                getString(styleName(next.style))));
        warning(all);

        LinearLayout rows = findViewById(R.id.alert_rows);
        rows.removeAllViews();
        long refresh = Long.MAX_VALUE;
        for (Alerts.Alert a : all) {
            rows.addView(row(a, running, now, zone));
            refresh = Math.min(refresh, nextAt(a, now, zone));
        }
        findViewById(R.id.alerts_empty).setVisibility(all.isEmpty() ? View.VISIBLE : View.GONE);
        ((TextView) findViewById(R.id.alerts_total)).setText(String.valueOf(all.size()));
        // Redraw when the next one is due, not on a timer.
        if (refresh != Long.MAX_VALUE) handler.postDelayed(render, Math.max(1000, refresh - now + 1500));
    }

    private static long nextAt(Alerts.Alert a, long now, ZoneId zone) {
        long next = Alerts.next(a, now, zone);
        if (a.enabled && a.snoozeAt > 0) return a.snoozeAt;
        return next > 0 ? next : Long.MAX_VALUE;
    }

    /** The first thing stopping alerts from working as set, with a button to fix it. */
    private void warning(List<Alerts.Alert> all) {
        boolean blocks = false, screens = false;
        for (Alerts.Alert a : all) {
            if (!a.enabled) continue;
            if (!"none".equals(a.blockMode)) blocks = true;
            if (!"notification".equals(a.style)) screens = true;
        }
        int text = 0;
        Intent fix = null;
        if (!all.isEmpty() && !getSystemService(NotificationManager.class).areNotificationsEnabled()) {
            text = R.string.alerts_need_notifications;
            fix = new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, getPackageName());
        } else if (screens && Build.VERSION.SDK_INT >= 34 && !getSystemService(NotificationManager.class).canUseFullScreenIntent()) {
            text = R.string.alerts_need_full_screen;
            fix = new Intent(Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT, Uri.fromParts("package", getPackageName(), null));
        } else if (blocks && !Device.blockingEnabled(this)) {
            text = R.string.alerts_need_blocking;
            fix = new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS);
        }
        findViewById(R.id.alerts_warning).setVisibility(text == 0 ? View.GONE : View.VISIBLE);
        if (text == 0) return;
        ((TextView) findViewById(R.id.alerts_warning_text)).setText(text);
        Intent open = fix;
        boolean ask = text == R.string.alerts_need_notifications && Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
                && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED;
        findViewById(R.id.alerts_warning_fix).setOnClickListener(v -> {
            if (ask) requestPermissions(new String[] { Manifest.permission.POST_NOTIFICATIONS }, 0); else open(open);
        });
    }

    private void open(Intent settings) {
        try { startActivity(settings); } catch (RuntimeException e) { startActivity(new Intent(Settings.ACTION_SETTINGS)); }
    }

    /** Once Android stops asking, the switch is in Settings. */
    @Override
    public void onRequestPermissionsResult(int code, String[] permissions, int[] results) {
        if (results.length > 0 && results[0] != PackageManager.PERMISSION_GRANTED)
            open(new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, getPackageName()));
        render();
    }

    /** One alert as a card: its time, repeat and switch, then what it's for and how it will act. */
    private View row(Alerts.Alert a, Session running, long now, ZoneId zone) {
        LinearLayout card = new LinearLayout(this);
        card.setOrientation(LinearLayout.VERTICAL);
        card.setBackgroundResource(R.drawable.card);
        card.setForeground(getDrawable(android.R.drawable.list_selector_background));
        card.setPadding(Math.round(18 * dp), Math.round(10 * dp), Math.round(10 * dp), Math.round(18 * dp));
        LinearLayout.LayoutParams gap = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        gap.topMargin = Math.round(12 * dp);
        card.setLayoutParams(gap);

        LinearLayout top = new LinearLayout(this);
        top.setGravity(Gravity.CENTER_VERTICAL);
        TextView clock = new TextView(this, null, 0, R.style.Title);
        clock.setTextSize(26);
        clock.setText(Store.clockText(this, a.time));
        TextView repeat = new TextView(this, null, 0, R.style.Tag);
        repeat.setText(("once".equals(a.repeat) ? Alerts.date(a.date).format(DateTimeFormatter.ofLocalizedDate(FormatStyle.MEDIUM))
                : getString("daily".equals(a.repeat) ? R.string.repeat_daily : R.string.repeat_weekdays)).toUpperCase(java.util.Locale.getDefault()));
        repeat.setPadding(Math.round(10 * dp), Math.round(4 * dp), 0, 0);
        top.addView(clock);
        top.addView(repeat, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1));
        card.addView(top);

        boolean session = a.sessionId != null && running != null && a.sessionId.equals(running.id);
        String status = a.enabled && a.snoozeAt > 0 ? getString(R.string.alert_status_snoozed, when(a.snoozeAt))
                : session ? getString(R.string.alert_status_session)
                : !a.enabled ? getString(R.string.alert_status_paused)
                : a.pending > 0 ? getString(R.string.alert_status_pending)
                : "once".equals(a.repeat) && a.lastOccurrence > 0 && Alerts.next(a, now, zone) == 0 ? getString(R.string.alert_status_done)
                : getString(R.string.alert_status_scheduled);
        String length = "range".equals(a.lengthMode)
                ? getString(a.endTime.compareTo(a.time) < 0 ? R.string.alert_until_next_day : R.string.alert_until, Store.clockText(this, a.endTime))
                : getString(R.string.alert_minutes, a.durationMinutes);
        int blocked = session ? running.apps.size() + running.websites.size() : 0;
        String blocking = session ? getResources().getQuantityString(R.plurals.alert_blocking_until, blocked, blocked,
                Store.time(this, now + running.remaining(Store.clock(this))))
                : "none".equals(a.blockMode) ? getString(R.string.alert_reminder_only)
                : "current".equals(a.blockMode) ? getString(R.string.alert_uses_focus_space)
                : getResources().getQuantityString(R.plurals.alert_blocks, a.apps.size(), a.apps.size());
        String result = session ? "" : a.sessionId != null ? getString(R.string.alert_session_ended) : a.lastResult;

        TextView title = new TextView(this, null, 0, R.style.CardTitle);
        title.setText(a.title);
        title.setPadding(0, 0, Math.round(8 * dp), 0);
        card.addView(title);
        TextView text = new TextView(this, null, 0, R.style.Hint);
        StringBuilder body = new StringBuilder(getString(styleName(a.style))).append(" · ").append(status)
                .append('\n').append(length).append(" · ").append(blocking);
        if (!result.isEmpty()) body.append('\n').append(result);
        text.setText(body);
        text.setPadding(0, Math.round(4 * dp), Math.round(8 * dp), 0);
        card.addView(text);
        for (View faded : new View[] { clock, repeat, title, text }) faded.setAlpha(a.enabled ? 1f : 0.6f); // Paused.

        Switch toggle = new Switch(this);
        toggle.setChecked(a.enabled);
        toggle.setContentDescription(getString(R.string.alert_enable, a.title));
        toggle.setOnClickListener(v -> {
            try {
                AlertStore.toggle(this, a.id);
            } catch (IOException | IllegalArgumentException e) {
                Toast.makeText(this, R.string.alert_save_failed, Toast.LENGTH_LONG).show();
            }
            render();
        });
        top.addView(toggle);
        card.setOnClickListener(v -> startActivity(new Intent(this, AlertEditActivity.class).putExtra(AlertEditActivity.ID, a.id)));
        return card;
    }

    static int styleName(String style) {
        return "full".equals(style) ? R.string.style_full : "card".equals(style) ? R.string.style_card : R.string.style_notification;
    }

    private String when(long at) {
        return DateTimeFormatter.ofLocalizedDateTime(FormatStyle.MEDIUM, FormatStyle.SHORT)
                .format(java.time.Instant.ofEpochMilli(at).atZone(ZoneId.systemDefault()));
    }
}

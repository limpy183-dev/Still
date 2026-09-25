package io.github.limpy183dev.still;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.provider.Settings;
import android.view.View;
import android.widget.Button;
import android.widget.CheckBox;
import android.widget.Chronometer;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

import java.io.IOException;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

public final class MainActivity extends Activity {
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final Runnable render = this::render;
    private final Set<String> selected = new HashSet<>();
    private final List<String> sites = new ArrayList<>();
    private SharedPreferences prefs;
    private AppPicker apps;
    private View blockingCard;
    private EditText intentionInput, durationInput, delayInput;
    private CheckBox delayEnabled, strict;
    private TextView appsLabel;
    private EditText siteInput;
    private LinearLayout siteList;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        setContentView(R.layout.activity_main);
        prefs = getSharedPreferences("prefs", MODE_PRIVATE);
        selected.addAll(prefs.getStringSet("selected", new HashSet<>()));
        for (String site : prefs.getString("websites", "").split("\n")) if (!site.isEmpty()) sites.add(site);

        blockingCard = findViewById(R.id.blocking_card);
        intentionInput = findViewById(R.id.intention_input);
        durationInput = findViewById(R.id.duration);
        delayInput = findViewById(R.id.delay);
        delayEnabled = findViewById(R.id.delay_enabled);
        strict = findViewById(R.id.strict);
        appsLabel = findViewById(R.id.apps_label);
        siteInput = findViewById(R.id.site_input);
        siteList = findViewById(R.id.site_list);

        intentionInput.setText(prefs.getString("intention", ""));
        durationInput.setText(String.valueOf(prefs.getInt("duration", 50)));
        delayInput.setText(String.valueOf(prefs.getInt("delay", 5)));
        delayEnabled.setChecked(prefs.getBoolean("delayEnabled", true));
        strict.setChecked(prefs.getBoolean("strict", true));
        delayInput.setEnabled(delayEnabled.isChecked());
        delayEnabled.setOnCheckedChangeListener((box, on) -> delayInput.setEnabled(on));

        apps = new AppPicker(this);
        findViewById(R.id.choose_apps).setOnClickListener(v -> chooseApps());
        findViewById(R.id.add_site).setOnClickListener(v -> addSite());
        View.OnClickListener openLimits = v -> startActivity(new Intent(this, LimitsActivity.class));
        findViewById(R.id.open_limits).setOnClickListener(openLimits);
        findViewById(R.id.open_limits_active).setOnClickListener(openLimits);
        View.OnClickListener openTodos = v -> startActivity(new Intent(this, TodosActivity.class));
        findViewById(R.id.open_todos).setOnClickListener(openTodos);
        findViewById(R.id.open_todos_active).setOnClickListener(openTodos);
        View.OnClickListener openHistory = v -> startActivity(new Intent(this, HistoryActivity.class));
        findViewById(R.id.open_history).setOnClickListener(openHistory);
        findViewById(R.id.open_history_active).setOnClickListener(openHistory);
        View.OnClickListener openAlerts = v -> startActivity(new Intent(this, AlertsActivity.class));
        findViewById(R.id.open_alerts).setOnClickListener(openAlerts);
        findViewById(R.id.open_alerts_active).setOnClickListener(openAlerts);
        findViewById(R.id.change_screen).setOnClickListener(v -> startActivity(new Intent(this, BlockScreenActivity.class)));
        siteInput.setOnEditorActionListener((view, action, event) -> { addSite(); return true; });
        renderSites();
        findViewById(R.id.enable_blocking).setOnClickListener(v ->
                startActivity(new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)));
        findViewById(R.id.app_info).setOnClickListener(v -> startActivity(
                new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", getPackageName(), null))));
        findViewById(R.id.start).setOnClickListener(v -> start());
        findViewById(R.id.request).setOnClickListener(v -> toggleRelease());
        findViewById(R.id.end).setOnClickListener(v -> end());

        if (Store.loadError != null || AlertStore.loadError != null) Toast.makeText(this, R.string.state_reset, Toast.LENGTH_LONG).show();
    }

    @Override
    protected void onResume() {
        super.onResume();
        AlertStore.tick(this); // Catches up on anything due, e.g. after an update.
        render();
    }

    @Override
    protected void onPause() {
        super.onPause();
        handler.removeCallbacks(render);
        ((Chronometer) findViewById(R.id.countdown)).stop();
        savePrefs();
    }

    private void render() {
        handler.removeCallbacks(render);
        String refused = Device.managedReason(this);
        show(R.id.refused, refused != null);
        if (refused != null) {
            ((TextView) findViewById(R.id.refused)).setText(refused);
            show(R.id.setup, false);
            show(R.id.active, false);
            return;
        }
        Session s = Store.current(this);
        show(R.id.setup, s == null);
        show(R.id.active, s != null);
        if (s == null) renderSetup(); else renderActive(s);
    }

    private void show(int id, boolean visible) { findViewById(id).setVisibility(visible ? View.VISIBLE : View.GONE); }

    private void renderSetup() {
        ((Chronometer) findViewById(R.id.countdown)).stop();
        blockingCard.setVisibility(Device.blockingEnabled(this) ? View.GONE : View.VISIBLE);
        ((TextView) findViewById(R.id.screen_summary)).setText(getString(R.string.screen_label,
                getString(BlockScreenActivity.name(BlockScreenActivity.saved(this).mode))));
        if (!apps.loaded()) {
            appsLabel.setText(R.string.apps_loading);
            apps.load(selected, this::updateSetup);
        }
        updateSetup();
    }

    private void chooseApps() { apps.choose(selected, this::updateSetup); }

    private void addSite() {
        String text = siteInput.getText().toString().trim();
        if (text.isEmpty()) return;
        try {
            String site = Websites.domain(text);
            if (!sites.contains(site)) {
                if (sites.size() + selected.size() >= Session.MAX_APPS) throw new IllegalArgumentException(getString(R.string.too_many));
                sites.add(site);
            }
            siteInput.setText("");
            renderSites();
            updateSetup();
        } catch (IllegalArgumentException e) {
            Toast.makeText(this, e.getMessage(), Toast.LENGTH_LONG).show();
        }
    }

    private void renderSites() {
        siteList.removeAllViews();
        int pad = Math.round(12 * getResources().getDisplayMetrics().density);
        for (String site : sites) {
            TextView row = new TextView(this, null, 0, R.style.Body);
            row.setText(site);
            row.setPadding(0, pad, 0, pad);
            row.setCompoundDrawablesRelativeWithIntrinsicBounds(0, 0, android.R.drawable.ic_menu_close_clear_cancel, 0);
            row.setContentDescription(getString(R.string.remove_site, site));
            row.setOnClickListener(v -> {
                sites.remove(site);
                renderSites();
                updateSetup();
            });
            siteList.addView(row);
        }
    }

    private void updateSetup() {
        if (!apps.loading) {
            Map<String, String> names = apps.chosen(selected);
            appsLabel.setText(names.isEmpty() ? getString(R.string.apps_none) : String.join(", ", names.values()));
        }
        findViewById(R.id.start).setEnabled((!selected.isEmpty() || !sites.isEmpty()) && !apps.loading);
        findViewById(R.id.choose_apps).setEnabled(!apps.loading);
    }

    private void start() {
        try {
            if (!Device.blockingEnabled(this)) {
                Toast.makeText(this, R.string.need_blocking, Toast.LENGTH_LONG).show();
                return;
            }
            int minutes = number(durationInput), delay = delayEnabled.isChecked() ? number(delayInput) : 0;
            if (delayEnabled.isChecked() && delay < 1) throw new IllegalArgumentException(getString(R.string.delay_range));
            Map<String, String> chosen = apps.chosen(selected);
            // Browsers whose address bar Still can't read would let blocked websites through, so they wait too.
            if (!sites.isEmpty()) for (Map.Entry<String, String> browser : Device.otherBrowsers(this).entrySet())
                chosen.putIfAbsent(browser.getKey(), browser.getValue());
            Session s = Session.start(UUID.randomUUID().toString(), intentionInput.getText().toString(), minutes, delay,
                    strict.isChecked(), chosen, sites, Store.clock(this));
            s.screen = Store.frozenScreen(this, s.websites);
            savePrefs();
            Store.start(this, s);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
                    && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED)
                requestPermissions(new String[] { Manifest.permission.POST_NOTIFICATIONS }, 0);
        } catch (IllegalArgumentException | IllegalStateException e) {
            Toast.makeText(this, e.getMessage(), Toast.LENGTH_LONG).show();
        } catch (IOException e) {
            Toast.makeText(this, R.string.save_failed, Toast.LENGTH_LONG).show();
        }
        render();
    }

    private static int number(EditText input) {
        try {
            return Integer.parseInt(input.getText().toString().trim());
        } catch (NumberFormatException e) {
            return -1;
        }
    }

    @Override
    public void onRequestPermissionsResult(int code, String[] permissions, int[] results) {
        Store.changed(this); // Post the session notification now that it may be allowed.
    }

    private void renderActive(Session s) {
        Session.Clock now = Store.clock(this);
        long left = s.remaining(now);
        ((TextView) findViewById(R.id.intention)).setText(s.intention);
        Chronometer countdown = findViewById(R.id.countdown);
        countdown.setBase(SystemClock.elapsedRealtime() + left);
        countdown.start();
        ((TextView) findViewById(R.id.until)).setText(getString(R.string.until, Store.time(this, now.wall + left)));
        List<String> targets = new ArrayList<>(s.apps.values());
        targets.addAll(s.websites);
        ((TextView) findViewById(R.id.blocking)).setText(getString(R.string.blocking_list, String.join(", ", targets)));

        TextView release = findViewById(R.id.release);
        Button request = findViewById(R.id.request);
        boolean canEnd = s.canEnd(now);
        findViewById(R.id.end).setEnabled(canEnd);
        long next = left;
        if (s.unlockDelayMinutes == 0) {
            release.setText(R.string.release_none);
            request.setVisibility(View.GONE);
        } else if (!s.unlockRequested()) {
            release.setText(getResources().getQuantityString(R.plurals.release_delay, s.unlockDelayMinutes, s.unlockDelayMinutes));
            request.setVisibility(View.VISIBLE);
            request.setText(R.string.request_release);
        } else {
            long wait = s.unlockRemaining(now);
            release.setText(canEnd ? getString(R.string.release_ready)
                    : getString(R.string.release_at, Store.time(this, now.wall + wait)));
            request.setVisibility(View.VISIBLE);
            request.setText(R.string.cancel_release);
            if (!canEnd) next = Math.min(next, wait);
        }
        // Redraw exactly when something changes (release allowed or session over), not on a timer.
        handler.postDelayed(render, Math.max(0, next) + 250);
    }

    private void toggleRelease() {
        Session s = Store.current(this);
        if (s == null) { render(); return; }
        if (s.unlockRequested()) s.cancelUnlock(); else s.requestUnlock(Store.clock(this));
        try {
            Store.update(this);
        } catch (IOException e) {
            Toast.makeText(this, R.string.save_failed, Toast.LENGTH_LONG).show();
        }
        render();
    }

    private void end() {
        Session s = Store.current(this);
        if (s != null && s.canEnd(Store.clock(this))) Store.finish(this, "ended-early");
        render();
    }

    private void savePrefs() {
        SharedPreferences.Editor edit = prefs.edit().putStringSet("selected", new HashSet<>(selected))
                .putString("intention", intentionInput.getText().toString())
                .putString("websites", String.join("\n", sites))
                .putBoolean("delayEnabled", delayEnabled.isChecked())
                .putBoolean("strict", strict.isChecked());
        int minutes = number(durationInput), delay = number(delayInput);
        if (minutes >= 1 && minutes <= Session.MAX_MINUTES) edit.putInt("duration", minutes);
        if (delay >= 1 && delay <= Session.MAX_DELAY) edit.putInt("delay", delay);
        edit.apply();
    }
}

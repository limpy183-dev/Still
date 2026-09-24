package io.github.limpy183dev.still;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.graphics.drawable.Drawable;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.provider.Settings;
import android.view.View;
import android.view.ViewGroup;
import android.widget.ArrayAdapter;
import android.widget.Button;
import android.widget.CheckBox;
import android.widget.Chronometer;
import android.widget.EditText;
import android.widget.ListView;
import android.widget.TextView;
import android.widget.Toast;

import java.io.IOException;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

public final class MainActivity extends Activity {
    private static final class App {
        final String pkg, label;
        final ResolveInfo info;
        Drawable icon;
        App(String pkg, String label, ResolveInfo info) { this.pkg = pkg; this.label = label; this.info = info; }
    }

    private final Handler handler = new Handler(Looper.getMainLooper());
    private final Runnable render = this::render;
    private final Set<String> selected = new HashSet<>();
    private SharedPreferences prefs;
    private ArrayAdapter<App> apps;
    private View blockingCard;
    private EditText intentionInput, durationInput, delayInput;
    private CheckBox delayEnabled, strict;
    private TextView appsLabel;
    private boolean appsLoading;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        setContentView(R.layout.activity_main);
        prefs = getSharedPreferences("prefs", MODE_PRIVATE);
        selected.addAll(prefs.getStringSet("selected", new HashSet<>()));

        blockingCard = findViewById(R.id.blocking_card);
        intentionInput = findViewById(R.id.intention_input);
        durationInput = findViewById(R.id.duration);
        delayInput = findViewById(R.id.delay);
        delayEnabled = findViewById(R.id.delay_enabled);
        strict = findViewById(R.id.strict);
        appsLabel = findViewById(R.id.apps_label);

        intentionInput.setText(prefs.getString("intention", ""));
        durationInput.setText(String.valueOf(prefs.getInt("duration", 50)));
        delayInput.setText(String.valueOf(prefs.getInt("delay", 5)));
        delayEnabled.setChecked(prefs.getBoolean("delayEnabled", true));
        strict.setChecked(prefs.getBoolean("strict", true));
        delayInput.setEnabled(delayEnabled.isChecked());
        delayEnabled.setOnCheckedChangeListener((box, on) -> delayInput.setEnabled(on));

        apps = new ArrayAdapter<App>(this, android.R.layout.simple_list_item_multiple_choice) {
            @Override
            public View getView(int position, View convert, ViewGroup parent) {
                TextView row = (TextView) super.getView(position, convert, parent);
                App app = getItem(position);
                row.setText(app.label);
                if (app.icon == null) {
                    app.icon = app.info.loadIcon(getPackageManager());
                    int size = Math.round(36 * getResources().getDisplayMetrics().density);
                    app.icon.setBounds(0, 0, size, size);
                }
                row.setCompoundDrawablesRelative(app.icon, null, null, null);
                row.setCompoundDrawablePadding(Math.round(16 * getResources().getDisplayMetrics().density));
                return row;
            }
        };
        findViewById(R.id.choose_apps).setOnClickListener(v -> chooseApps());
        findViewById(R.id.enable_blocking).setOnClickListener(v ->
                startActivity(new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)));
        findViewById(R.id.app_info).setOnClickListener(v -> startActivity(
                new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", getPackageName(), null))));
        findViewById(R.id.start).setOnClickListener(v -> start());
        findViewById(R.id.request).setOnClickListener(v -> toggleRelease());
        findViewById(R.id.end).setOnClickListener(v -> end());

        if (Store.loadError != null) Toast.makeText(this, R.string.state_reset, Toast.LENGTH_LONG).show();
    }

    @Override
    protected void onResume() {
        super.onResume();
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
        if (apps.isEmpty() && !appsLoading) loadApps();
        updateSetup();
    }

    /** Lists launchable apps off the main thread; protected apps are left out. */
    private void loadApps() {
        appsLoading = true;
        appsLabel.setText(R.string.apps_loading);
        new Thread(() -> {
            PackageManager pm = getPackageManager();
            Set<String> skip = Device.protectedPackages(this);
            Map<String, App> found = new LinkedHashMap<>();
            Intent launcher = new Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER);
            for (ResolveInfo info : pm.queryIntentActivities(launcher, 0)) {
                String pkg = info.activityInfo.packageName;
                if (!skip.contains(pkg) && !found.containsKey(pkg)) found.put(pkg, new App(pkg, String.valueOf(info.loadLabel(pm)), info));
            }
            List<App> sorted = new ArrayList<>(found.values());
            sorted.sort((a, b) -> a.label.compareToIgnoreCase(b.label));
            runOnUiThread(() -> {
                if (isDestroyed()) return;
                appsLoading = false;
                apps.addAll(sorted);
                selected.retainAll(found.keySet());
                updateSetup();
            });
        }).start();
    }

    /** The picker is a dialog so the list only exists (and loads icons) while it is open. */
    private void chooseApps() {
        if (appsLoading) return;
        ListView list = new ListView(this);
        list.setChoiceMode(ListView.CHOICE_MODE_MULTIPLE);
        list.setAdapter(apps);
        for (int i = 0; i < apps.getCount(); i++) list.setItemChecked(i, selected.contains(apps.getItem(i).pkg));
        list.setOnItemClickListener((parent, view, position, id) -> {
            App app = apps.getItem(position);
            if (list.isItemChecked(position)) selected.add(app.pkg); else selected.remove(app.pkg);
            updateSetup();
        });
        new AlertDialog.Builder(this).setTitle(R.string.apps_title).setView(list)
                .setPositiveButton(R.string.done, null)
                .setOnDismissListener(d -> { for (int i = 0; i < apps.getCount(); i++) apps.getItem(i).icon = null; })
                .show();
    }

    private void updateSetup() {
        if (!appsLoading) {
            List<String> names = new ArrayList<>();
            for (int i = 0; i < apps.getCount(); i++) if (selected.contains(apps.getItem(i).pkg)) names.add(apps.getItem(i).label);
            appsLabel.setText(names.isEmpty() ? getString(R.string.apps_none) : String.join(", ", names));
        }
        findViewById(R.id.start).setEnabled(!selected.isEmpty() && !appsLoading);
        findViewById(R.id.choose_apps).setEnabled(!appsLoading);
    }

    private void start() {
        try {
            if (!Device.blockingEnabled(this)) {
                Toast.makeText(this, R.string.need_blocking, Toast.LENGTH_LONG).show();
                return;
            }
            int minutes = number(durationInput), delay = delayEnabled.isChecked() ? number(delayInput) : 0;
            if (delayEnabled.isChecked() && delay < 1) throw new IllegalArgumentException(getString(R.string.delay_range));
            Map<String, String> chosen = new LinkedHashMap<>();
            for (int i = 0; i < apps.getCount(); i++) {
                App app = apps.getItem(i);
                if (selected.contains(app.pkg)) chosen.put(app.pkg, app.label);
            }
            Session s = Session.start(UUID.randomUUID().toString(), intentionInput.getText().toString(), minutes, delay,
                    strict.isChecked(), chosen, Store.clock(this));
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
        ((TextView) findViewById(R.id.blocking)).setText(getString(R.string.blocking_list, String.join(", ", s.apps.values())));

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
                .putBoolean("delayEnabled", delayEnabled.isChecked())
                .putBoolean("strict", strict.isChecked());
        int minutes = number(durationInput), delay = number(delayInput);
        if (minutes >= 1 && minutes <= Session.MAX_MINUTES) edit.putInt("duration", minutes);
        if (delay >= 1 && delay <= Session.MAX_DELAY) edit.putInt("delay", delay);
        edit.apply();
    }
}

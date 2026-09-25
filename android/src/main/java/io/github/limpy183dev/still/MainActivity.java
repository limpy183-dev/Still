package io.github.limpy183dev.still;

import android.Manifest;
import android.animation.ObjectAnimator;
import android.animation.PropertyValuesHolder;
import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.RectF;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.text.Editable;
import android.text.SpannableString;
import android.text.Spanned;
import android.text.TextWatcher;
import android.text.style.ForegroundColorSpan;
import android.text.style.RelativeSizeSpan;
import android.util.AttributeSet;
import android.view.View;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.CompoundButton;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

import java.io.IOException;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

/** Focus space: the desktop focus page in one column, with the timer ring, presets and the side cards below. */
public final class MainActivity extends Activity {
    private static final int[] PRESETS = { 25, 50, 90 };
    private static final int[] PRESET_IDS = { R.id.preset_25, R.id.preset_50, R.id.preset_90 };
    private static final int[] PRESET_NOTES = { R.string.preset_25_note, R.string.preset_50_note, R.string.preset_90_note };

    private final Handler handler = new Handler(Looper.getMainLooper());
    private final Runnable render = this::render, tick = this::tick;
    private final Set<String> selected = new HashSet<>();
    private final List<String> sites = new ArrayList<>();
    /** The breathing glow and pulsing status while a session runs; restarted on each render. */
    private final List<ObjectAnimator> loops = new ArrayList<>();
    private ObjectAnimator leaf;
    private SharedPreferences prefs;
    private AppPicker apps;
    private EditText intentionInput, durationInput, delayInput;
    private CompoundButton delayEnabled, strict;
    private TextView appsLabel, timer, status;
    private EditText siteInput;
    private LinearLayout siteList;
    private Ring ring;
    private float dp;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        setContentView(R.layout.activity_main);
        dp = getResources().getDisplayMetrics().density;
        prefs = getSharedPreferences("prefs", MODE_PRIVATE);
        selected.addAll(prefs.getStringSet("selected", new HashSet<>()));
        for (String site : prefs.getString("websites", "").split("\n")) if (!site.isEmpty()) sites.add(site);

        intentionInput = findViewById(R.id.intention_input);
        durationInput = findViewById(R.id.duration);
        delayInput = findViewById(R.id.delay);
        delayEnabled = findViewById(R.id.delay_enabled);
        strict = findViewById(R.id.strict);
        appsLabel = findViewById(R.id.apps_label);
        siteInput = findViewById(R.id.site_input);
        siteList = findViewById(R.id.site_list);
        timer = findViewById(R.id.timer_number);
        status = findViewById(R.id.status);
        ring = findViewById(R.id.ring);

        intentionInput.setText(prefs.getString("intention", ""));
        durationInput.setText(String.valueOf(prefs.getInt("duration", 50)));
        delayInput.setText(String.valueOf(prefs.getInt("delay", 5)));
        delayEnabled.setChecked(prefs.getBoolean("delayEnabled", true));
        strict.setChecked(prefs.getBoolean("strict", true));
        delayInput.setEnabled(delayEnabled.isChecked());
        delayEnabled.setOnCheckedChangeListener((box, on) -> delayInput.setEnabled(on));

        // The presets and the minutes field stay in step, and the timer previews the length, as on Windows.
        for (int i = 0; i < PRESETS.length; i++) {
            String minutes = String.valueOf(PRESETS[i]);
            TextView preset = findViewById(PRESET_IDS[i]);
            // "50 min" over a smaller "Find your flow", like .duration-presets button span.
            String label = preset.getText().toString(), note = getString(PRESET_NOTES[i]);
            SpannableString text = new SpannableString(label + "\n" + note);
            text.setSpan(new RelativeSizeSpan(0.78f), label.length() + 1, text.length(), Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
            text.setSpan(new ForegroundColorSpan(getColor(R.color.muted)), label.length() + 1, text.length(), Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
            preset.setText(text);
            preset.setOnClickListener(v -> {
                durationInput.setText(minutes);
                durationInput.clearFocus();
            });
        }
        durationInput.addTextChangedListener(new TextWatcher() {
            @Override public void beforeTextChanged(CharSequence s, int a, int b, int c) { }
            @Override public void onTextChanged(CharSequence s, int a, int b, int c) { }
            @Override public void afterTextChanged(Editable s) { if (Store.current(MainActivity.this) == null) showDuration(); }
        });
        showDuration();

        apps = new AppPicker(this);
        findViewById(R.id.choose_apps).setOnClickListener(v -> chooseApps());
        findViewById(R.id.add_site).setOnClickListener(v -> addSite());
        findViewById(R.id.change_screen).setOnClickListener(v -> startActivity(new Intent(this, BlockScreenActivity.class)));
        siteInput.setOnEditorActionListener((view, action, event) -> { addSite(); return true; });
        renderSites();
        View.OnClickListener enable = v -> startActivity(new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS));
        findViewById(R.id.enable_blocking).setOnClickListener(enable);
        status.setOnClickListener(enable);
        findViewById(R.id.app_info).setOnClickListener(v -> startActivity(
                new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", getPackageName(), null))));
        findViewById(R.id.start).setOnClickListener(v -> start());
        findViewById(R.id.request).setOnClickListener(v -> toggleRelease());
        findViewById(R.id.end).setOnClickListener(v -> end());
        Nav.attach(this, Nav.FOCUS);

        if (Store.loadError != null || AlertStore.loadError != null) Toast.makeText(this, R.string.state_reset, Toast.LENGTH_LONG).show();
    }

    @Override
    protected void onResume() {
        super.onResume();
        AlertStore.tick(this); // Catches up on anything due, e.g. after an update.
        render();
        Nav.resumed(this);
        // The leaf floats while the page is on screen, like .floating-leaf.
        leaf = Nav.loop(findViewById(R.id.leaf), 2500, PropertyValuesHolder.ofFloat(View.TRANSLATION_Y, 0, -5 * dp));
    }

    @Override
    protected void onPause() {
        super.onPause();
        handler.removeCallbacks(render);
        handler.removeCallbacks(tick);
        stopLoops();
        leaf.cancel();
        findViewById(R.id.leaf).setTranslationY(0);
        savePrefs();
    }

    private void stopLoops() {
        for (ObjectAnimator loop : loops) loop.cancel();
        loops.clear();
        View glow = findViewById(R.id.glow);
        glow.setScaleX(1);
        glow.setScaleY(1);
        glow.setAlpha(1);
        status.setAlpha(1);
    }

    private void render() {
        handler.removeCallbacks(render);
        handler.removeCallbacks(tick);
        stopLoops();
        String refused = Device.managedReason(this);
        show(R.id.refused, refused != null);
        show(R.id.scroll, refused == null);
        if (refused != null) {
            ((TextView) findViewById(R.id.refused)).setText(refused);
            return;
        }
        Session s = Store.current(this);
        boolean running = s != null, blocking = Device.blockingEnabled(this);
        show(R.id.setup, !running);
        show(R.id.active, running);
        show(R.id.start, !running);
        show(R.id.start_caption, !running);
        show(R.id.end, running);
        show(R.id.apps_card, !running);
        show(R.id.delay_card, !running);
        show(R.id.screen_card, !running);
        show(R.id.blocking_card, !blocking);
        ((TextView) findViewById(R.id.session_title)).setText(running ? R.string.session_title_active : R.string.session_title);
        ((TextView) findViewById(R.id.session_tag)).setText(running ? R.string.session_tag_active : R.string.session_tag);
        ((TextView) findViewById(R.id.timer_top)).setText(running ? R.string.timer_top_active : R.string.timer_top);
        TextView caption = findViewById(R.id.timer_bottom);
        caption.setText(running ? R.string.timer_bottom_active : R.string.timer_bottom);
        caption.setCompoundDrawablesRelativeWithIntrinsicBounds(running ? 0 : R.drawable.dot, 0, 0, 0); // The longer line wraps.
        findViewById(R.id.glow).setBackgroundResource(running ? R.drawable.glow_running : R.drawable.glow);
        renderStatus(running, blocking);
        renderToday();
        if (running) renderActive(s); else renderSetup();
    }

    private void show(int id, boolean visible) { findViewById(id).setVisibility(visible ? View.VISIBLE : View.GONE); }

    /** .status-pill: set up, ready, or protecting a session (with the dot pulsing). */
    private void renderStatus(boolean running, boolean blocking) {
        status.setText(!blocking ? R.string.status_setup : running ? R.string.status_live : R.string.status_ready);
        status.setCompoundDrawablesRelativeWithIntrinsicBounds(R.drawable.dot, 0, blocking ? R.drawable.ic_shield_small : R.drawable.ic_arrow_small, 0);
        status.setClickable(!running);
        if (running && blocking) loops.add(Nav.loop(status, 1000, PropertyValuesHolder.ofFloat(View.ALPHA, 1, 0.7f)));
    }

    private void renderSetup() {
        ((TextView) findViewById(R.id.screen_summary)).setText(getString(R.string.screen_label,
                getString(BlockScreenActivity.name(BlockScreenActivity.saved(this).mode))));
        if (!apps.loaded()) {
            appsLabel.setText(R.string.apps_loading);
            apps.load(selected, this::updateSetup);
        }
        showDuration();
        updateSetup();
    }

    /** The timer and presets while setting up: the chosen length, full ring. */
    private void showDuration() {
        int minutes = number(durationInput);
        boolean valid = minutes >= 1 && minutes <= Session.MAX_MINUTES;
        setTimer(valid ? minutes * 60000L : 0);
        ring.set(1, false);
        for (int i = 0; i < PRESETS.length; i++) findViewById(PRESET_IDS[i]).setSelected(PRESETS[i] == minutes);
    }

    private void setTimer(long ms) {
        String text = clock(ms);
        SpannableString styled = new SpannableString(text);
        int colon = text.lastIndexOf(':');
        styled.setSpan(new ForegroundColorSpan(getColor(R.color.soft_ink)), colon, text.length(), Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
        timer.setText(styled);
        int minutes = (int) ((ms + 59999) / 60000);
        timer.setContentDescription(getResources().getQuantityString(R.plurals.timer_a11y, minutes, minutes));
    }

    /** "50:00" and "90:00", like formatClock in app/renderer.js: whole minutes, then seconds, rounded up. */
    static String clock(long ms) {
        long seconds = Math.max(0, (ms + 999) / 1000);
        return String.format(Locale.ROOT, "%02d:%02d", seconds / 60, seconds % 60);
    }

    /** .today-card: minutes today and a bar for each of the last seven days. */
    private void renderToday() {
        long now = System.currentTimeMillis();
        List<History.Day> days = History.days(Store.records(this), 7, LocalDate.now(), ZoneId.systemDefault(), now);
        double max = 30;
        for (History.Day d : days) max = Math.max(max, d.minutes);
        ((TextView) findViewById(R.id.today_minutes)).setText(String.valueOf((int) Math.floor(days.get(6).minutes)));
        LinearLayout bars = findViewById(R.id.week_bars);
        bars.removeAllViews();
        StringBuilder spoken = new StringBuilder();
        for (int i = 0; i < days.size(); i++) {
            View bar = new View(this);
            GradientDrawable shape = new GradientDrawable();
            shape.setCornerRadius(3 * dp);
            shape.setColor(getColor(i == 6 ? R.color.bar_today : R.color.bar));
            bar.setBackground(shape);
            LinearLayout.LayoutParams size = new LinearLayout.LayoutParams(Math.round(7 * dp),
                    (int) Math.round(Math.max(4, days.get(i).minutes / max * 40) * dp));
            if (i > 0) size.setMarginStart(Math.round(5 * dp));
            bars.addView(bar, size);
            spoken.append(i > 0 ? ", " : "").append((int) Math.floor(days.get(i).minutes));
        }
        bars.setContentDescription(getString(R.string.today_bars, spoken));
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

    /** Each website as a row you can tap to remove. */
    private void renderSites() {
        siteList.removeAllViews();
        int pad = Math.round(12 * dp);
        for (String site : sites) {
            TextView row = new TextView(this, null, 0, R.style.Body);
            row.setText(site);
            row.setBackgroundResource(R.drawable.chip);
            row.setPadding(pad, pad, pad, pad);
            row.setCompoundDrawablesRelativeWithIntrinsicBounds(0, 0, R.drawable.ic_close, 0);
            row.setCompoundDrawableTintList(getColorStateList(R.color.muted));
            row.setContentDescription(getString(R.string.remove_site, site));
            row.setOnClickListener(v -> {
                sites.remove(site);
                renderSites();
                updateSetup();
            });
            LinearLayout.LayoutParams gap = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
            gap.topMargin = Math.round(6 * dp);
            siteList.addView(row, gap);
        }
    }

    private void updateSetup() {
        if (!apps.loading) {
            Map<String, String> names = apps.chosen(selected);
            appsLabel.setText(names.isEmpty() ? getString(R.string.apps_none) : String.join(", ", names.values()));
        }
        ((TextView) findViewById(R.id.selected_count)).setText(String.valueOf(selected.size() + sites.size()));
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
            findViewById(R.id.scroll).scrollTo(0, 0);
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
        ((TextView) findViewById(R.id.until)).setText(getString(R.string.until, Store.time(this, now.wall + left)));
        List<String> targets = new ArrayList<>(s.apps.values());
        targets.addAll(s.websites);
        ((TextView) findViewById(R.id.blocking)).setText(getString(R.string.blocking_list, String.join(", ", targets)));

        TextView release = findViewById(R.id.release);
        Button request = findViewById(R.id.request);
        boolean canEnd = s.canEnd(now);
        findViewById(R.id.end).setEnabled(canEnd);
        show(R.id.unlock_box, s.unlockDelayMinutes > 0);
        long next = left;
        if (s.unlockDelayMinutes == 0) {
            release.setText(R.string.release_none);
        } else if (!s.unlockRequested()) {
            release.setText(getResources().getQuantityString(R.plurals.release_delay, s.unlockDelayMinutes, s.unlockDelayMinutes));
            request.setText(R.string.request_release);
        } else {
            long wait = s.unlockRemaining(now);
            release.setText(canEnd ? getString(R.string.release_ready)
                    : getString(R.string.release_at, Store.time(this, now.wall + wait)));
            request.setText(R.string.cancel_release);
            if (!canEnd) next = Math.min(next, wait);
        }
        // Redraw exactly when something changes (release allowed or session over); the clock ticks separately.
        handler.postDelayed(render, Math.max(0, next) + 250);
        loops.add(Nav.loop(findViewById(R.id.glow), 3000, // .focus-card.running breathes.
                PropertyValuesHolder.ofFloat(View.SCALE_X, 1, 1.04f), PropertyValuesHolder.ofFloat(View.SCALE_Y, 1, 1.04f),
                PropertyValuesHolder.ofFloat(View.ALPHA, 1, 0.75f)));
        tick();
    }

    /** Once a second while a session is on screen: the countdown, the ring, and the time left before release. */
    private void tick() {
        Session s = Store.current(this);
        if (s == null) { render(); return; }
        Session.Clock now = Store.clock(this);
        long left = s.remaining(now);
        setTimer(left);
        ring.set(Math.max(0, Math.min(1, left / (float) s.length())), true);
        Button end = findViewById(R.id.end);
        if (s.unlockRequested() && !s.canEnd(now)) end.setText(getString(R.string.release_in, clock(s.unlockRemaining(now))));
        else end.setText(R.string.end);
        handler.postDelayed(tick, left % 1000 + 20);
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

    /** .timer-ring: a hairline track and the time left as an arc from the top. */
    public static final class Ring extends View {
        private final Paint track = new Paint(Paint.ANTI_ALIAS_FLAG), arc = new Paint(Paint.ANTI_ALIAS_FLAG);
        private final RectF box = new RectF();
        private float progress = 1;
        private boolean running;

        public Ring(Context c, AttributeSet attrs) {
            super(c, attrs);
            float dp = c.getResources().getDisplayMetrics().density;
            track.setStyle(Paint.Style.STROKE);
            track.setStrokeWidth(2 * dp);
            track.setColor(c.getColor(R.color.orbit_soft));
            arc.setStyle(Paint.Style.STROKE);
            arc.setStrokeWidth(3 * dp);
            arc.setStrokeCap(Paint.Cap.ROUND);
            arc.setColor(c.getColor(R.color.ring));
        }

        void set(float progress, boolean running) {
            if (progress == this.progress && running == this.running) return;
            this.progress = progress;
            this.running = running;
            arc.setColor(getContext().getColor(running ? R.color.ring_running : R.color.ring));
            invalidate();
        }

        @Override
        protected void onDraw(Canvas canvas) {
            float inset = arc.getStrokeWidth();
            box.set(inset, inset, getWidth() - inset, getHeight() - inset);
            canvas.drawOval(box, track);
            if (progress > 0) canvas.drawArc(box, -90, 360 * progress, false, arc);
        }
    }
}

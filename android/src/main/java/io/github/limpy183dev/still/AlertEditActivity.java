package io.github.limpy183dev.still;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.app.DatePickerDialog;
import android.app.TimePickerDialog;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.OpenableColumns;
import android.text.format.DateFormat;
import android.view.View;
import android.webkit.MimeTypeMap;
import android.widget.Button;
import android.widget.CheckBox;
import android.widget.EditText;
import android.widget.RadioGroup;
import android.widget.SeekBar;
import android.widget.Spinner;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONException;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.time.LocalDate;
import java.time.LocalTime;
import java.time.format.DateTimeFormatter;
import java.time.format.FormatStyle;
import java.util.Arrays;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

/** Creates or edits one alert, with the Windows editor's fields and rules. */
public final class AlertEditActivity extends Activity {
    static final String ID = "id";
    private static final int PICK_SOUND = 1, PICK_BANNER = 2;
    private static final long MAX_MEDIA_BYTES = 200L * 1024 * 1024;
    private static final List<String> SOUND_TYPES = Arrays.asList("mp3", "wav", "ogg", "m4a", "aac", "flac", "mp4", "mov", "webm"),
            BANNER_TYPES = Arrays.asList("png", "jpg", "jpeg", "gif", "webp", "mp4", "mov", "webm");

    private Alerts.Alert alert;
    private boolean editing, copying;
    private final Set<String> apps = new HashSet<>();
    private final Map<String, String> labels = new java.util.HashMap<>();
    private AppPicker picker;
    private EditText title, note, duration, snoozeLimit, sites, delay;
    private Button date, time, endTime, soundPick, bannerPick;
    private RadioGroup repeat, length, style, block;
    private Spinner sound;
    private SeekBar volume;
    private CheckBox showDismiss;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        setContentView(R.layout.activity_alert_edit);
        Alerts.Alert saved = AlertStore.find(this, String.valueOf(getIntent().getStringExtra(ID)));
        editing = saved != null;
        alert = editing ? AlertStore.copy(saved) : fresh();
        picker = new AppPicker(this);

        title = findViewById(R.id.alert_title);
        note = findViewById(R.id.alert_note);
        duration = findViewById(R.id.alert_duration);
        snoozeLimit = findViewById(R.id.alert_snooze_limit);
        sites = findViewById(R.id.alert_sites);
        delay = findViewById(R.id.alert_delay);
        date = findViewById(R.id.alert_date);
        time = findViewById(R.id.alert_time);
        endTime = findViewById(R.id.alert_end);
        soundPick = findViewById(R.id.alert_sound_pick);
        bannerPick = findViewById(R.id.alert_banner_pick);
        repeat = findViewById(R.id.alert_repeat);
        length = findViewById(R.id.alert_length);
        style = findViewById(R.id.alert_style);
        block = findViewById(R.id.alert_block);
        sound = findViewById(R.id.alert_sound);
        volume = findViewById(R.id.alert_volume);
        showDismiss = findViewById(R.id.alert_show_dismiss);

        ((TextView) findViewById(R.id.alert_heading)).setText(editing ? R.string.alert_edit_title : R.string.alert_new_title);
        title.setText(alert.title);
        note.setText(alert.note);
        duration.setText(String.valueOf(alert.durationMinutes));
        snoozeLimit.setText(alert.snoozeLimit == null ? "" : String.valueOf(alert.snoozeLimit));
        delay.setText(String.valueOf(alert.unlockDelayMinutes));
        showDismiss.setChecked(alert.showDismiss);
        repeat.check(new int[] { R.id.repeat_once, R.id.repeat_daily, R.id.repeat_weekdays }[Alerts.REPEATS.indexOf(alert.repeat)]);
        length.check("range".equals(alert.lengthMode) ? R.id.length_range : R.id.length_duration);
        style.check(new int[] { R.id.style_full, R.id.style_card, R.id.style_notification }[Alerts.STYLES.indexOf(alert.style)]);
        block.check(new int[] { R.id.block_none, R.id.block_current, R.id.block_custom }[Alerts.BLOCK_MODES.indexOf(alert.blockMode)]);
        sound.setSelection(Alerts.SOUNDS.indexOf(alert.sound));
        volume.setProgress(alert.volume);
        StringBuilder domains = new StringBuilder();
        for (String path : alert.apps.keySet()) {
            if (Alerts.isWebsite(path)) domains.append(path.substring(Alerts.WEBSITE.length())).append('\n');
            else { apps.add(path); labels.put(path, alert.apps.get(path)); }
        }
        sites.setText(domains.toString().trim());

        date.setOnClickListener(v -> {
            LocalDate d = Alerts.date(alert.date);
            new DatePickerDialog(this, (p, y, m, day) -> { alert.date = LocalDate.of(y, m + 1, day).toString(); update(); },
                    d.getYear(), d.getMonthValue() - 1, d.getDayOfMonth()).show();
        });
        time.setOnClickListener(v -> pickTime(true));
        endTime.setOnClickListener(v -> pickTime(false));
        RadioGroup.OnCheckedChangeListener changed = (g, id) -> update();
        for (RadioGroup g : new RadioGroup[] { repeat, length, style, block }) g.setOnCheckedChangeListener(changed);
        sound.setOnItemSelectedListener(new android.widget.AdapterView.OnItemSelectedListener() {
            @Override public void onItemSelected(android.widget.AdapterView<?> p, View v, int i, long id) { update(); }
            @Override public void onNothingSelected(android.widget.AdapterView<?> p) { }
        });
        volume.setOnSeekBarChangeListener(new SeekBar.OnSeekBarChangeListener() {
            @Override public void onProgressChanged(SeekBar bar, int value, boolean user) { update(); }
            @Override public void onStartTrackingTouch(SeekBar bar) { }
            @Override public void onStopTrackingTouch(SeekBar bar) { }
        });
        soundPick.setOnClickListener(v -> pick(PICK_SOUND, "audio/*", "video/*"));
        bannerPick.setOnClickListener(v -> pick(PICK_BANNER, "image/*", "video/*"));
        findViewById(R.id.alert_banner_remove).setOnClickListener(v -> { alert.banner = null; alert.bannerName = null; update(); });
        findViewById(R.id.alert_choose_apps).setOnClickListener(v -> picker.choose(apps, this::update));
        findViewById(R.id.alert_copy_apps).setOnClickListener(v -> {
            apps.clear();
            apps.addAll(getSharedPreferences("prefs", MODE_PRIVATE).getStringSet("selected", new HashSet<>()));
            sites.setText(getSharedPreferences("prefs", MODE_PRIVATE).getString("websites", ""));
            update();
        });
        findViewById(R.id.alert_preview).setOnClickListener(v -> preview());
        findViewById(R.id.alert_save).setOnClickListener(v -> save());
        View delete = findViewById(R.id.alert_delete);
        delete.setVisibility(editing ? View.VISIBLE : View.GONE);
        delete.setOnClickListener(v -> new AlertDialog.Builder(this).setTitle(R.string.alert_delete_title)
                .setMessage(R.string.alert_delete_text)
                .setPositiveButton(R.string.alert_delete, (d, w) -> {
                    try {
                        AlertStore.delete(this, alert.id);
                        finish();
                    } catch (IOException e) {
                        Toast.makeText(this, R.string.alert_save_failed, Toast.LENGTH_LONG).show();
                    }
                }).setNegativeButton(R.string.cancel, null).show());
        picker.load(apps, this::update);
        update();
    }

    /** A new alert: in five minutes, today, for 50 minutes, as a focus card (the Windows defaults). */
    private Alerts.Alert fresh() {
        Alerts.Alert a = new Alerts.Alert();
        java.time.LocalDateTime soon = java.time.LocalDateTime.now().plusMinutes(5);
        a.title = "";
        a.date = soon.toLocalDate().toString();
        a.time = hhmm(soon.getHour(), soon.getMinute());
        java.time.LocalDateTime end = soon.plusMinutes(50);
        a.endTime = hhmm(end.getHour(), end.getMinute());
        android.content.SharedPreferences prefs = getSharedPreferences("prefs", MODE_PRIVATE);
        a.unlockDelayMinutes = prefs.getBoolean("delayEnabled", true) ? prefs.getInt("delay", 5) : 0;
        return a;
    }

    private static String hhmm(int hour, int minute) { return String.format(Locale.ROOT, "%02d:%02d", hour, minute); }

    private void pickTime(boolean start) {
        LocalTime at = LocalTime.parse(start ? alert.time : alert.endTime);
        new TimePickerDialog(this, (p, h, m) -> {
            if (start) alert.time = hhmm(h, m); else alert.endTime = hhmm(h, m);
            update();
        }, at.getHour(), at.getMinute(), DateFormat.is24HourFormat(this)).show();
    }

    /** Reads the form into {@code alert} and shows only the fields that apply. */
    private void read() {
        alert.title = title.getText().toString();
        alert.note = note.getText().toString();
        alert.durationMinutes = number(duration, -1);
        String limit = snoozeLimit.getText().toString().trim();
        alert.snoozeLimit = limit.isEmpty() ? null : number(snoozeLimit, -1);
        alert.unlockDelayMinutes = number(delay, -1);
        alert.showDismiss = showDismiss.isChecked();
        alert.repeat = Alerts.REPEATS.get(index(repeat));
        alert.lengthMode = length.getCheckedRadioButtonId() == R.id.length_range ? "range" : "duration";
        alert.style = Alerts.STYLES.get(index(style));
        alert.blockMode = Alerts.BLOCK_MODES.get(index(block));
        alert.sound = Alerts.SOUNDS.get(sound.getSelectedItemPosition());
        alert.volume = volume.getProgress();
        alert.apps.clear();
        if ("custom".equals(alert.blockMode)) {
            alert.apps.putAll(picker.chosen(apps));
            // Apps not listed (e.g. still loading) keep their saved names.
            for (String pkg : apps) alert.apps.putIfAbsent(pkg, labels.getOrDefault(pkg, pkg));
            for (String line : sites.getText().toString().split("[\\s,]+"))
                if (!line.isEmpty()) {
                    String domain = Websites.domain(line);
                    alert.apps.put(Alerts.WEBSITE + domain, domain);
                }
        }
    }

    private static int index(RadioGroup group) { return group.indexOfChild(group.findViewById(group.getCheckedRadioButtonId())); }

    private void update() {
        try { read(); } catch (IllegalArgumentException invalidWebsite) { } // Reported on save.
        DateTimeFormatter medium = DateTimeFormatter.ofLocalizedDate(FormatStyle.MEDIUM);
        date.setText(Alerts.date(alert.date).format(medium));
        time.setText(Store.clockText(this, alert.time));
        boolean range = "range".equals(alert.lengthMode), quiet = "notification".equals(alert.style);
        endTime.setText(alert.endTime.compareTo(alert.time) < 0
                ? getString(R.string.alert_next_day, Store.clockText(this, alert.endTime)) : Store.clockText(this, alert.endTime));
        show(R.id.alert_duration_row, !range);
        show(R.id.alert_end_row, range);
        ((TextView) findViewById(R.id.alert_date_label)).setText("once".equals(alert.repeat) ? R.string.alert_on : R.string.alert_from);
        ((TextView) findViewById(R.id.alert_style_text)).setText(new int[] { R.string.style_full_text, R.string.style_card_text,
                R.string.style_notification_text }[Alerts.STYLES.indexOf(alert.style)]);
        show(R.id.alert_volume_row, !quiet);
        show(R.id.alert_sound_pick, !quiet && "custom".equals(alert.sound));
        soundPick.setText(alert.soundFile == null ? getString(R.string.alert_sound_choose) : getString(R.string.alert_file, alert.soundName));
        show(R.id.alert_banner_row, !quiet);
        bannerPick.setText(alert.banner == null ? getString(R.string.alert_banner_choose) : getString(R.string.alert_file, alert.bannerName));
        show(R.id.alert_banner_remove, alert.banner != null);
        ((TextView) findViewById(R.id.alert_volume_label)).setText(getString(R.string.alert_volume, alert.volume));
        show(R.id.alert_custom, "custom".equals(alert.blockMode));
        show(R.id.alert_block_details, !"none".equals(alert.blockMode));
        show(R.id.alert_current_note, "current".equals(alert.blockMode));
        if (!picker.loading) {
            Map<String, String> names = picker.chosen(apps);
            ((TextView) findViewById(R.id.alert_apps_label)).setText(names.isEmpty() ? getString(R.string.apps_none) : String.join(", ", names.values()));
        }
    }

    private void show(int id, boolean visible) { findViewById(id).setVisibility(visible ? View.VISIBLE : View.GONE); }

    private static int number(EditText input, int fallback) {
        try {
            return Integer.parseInt(input.getText().toString().trim());
        } catch (NumberFormatException e) {
            return fallback;
        }
    }

    private void save() {
        try {
            read();
            AlertStore.save(this, alert);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
                    && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED)
                requestPermissions(new String[] { Manifest.permission.POST_NOTIFICATIONS }, 0);
            Toast.makeText(this, R.string.alert_saved, Toast.LENGTH_SHORT).show();
            finish();
        } catch (IllegalArgumentException e) {
            Toast.makeText(this, e.getMessage(), Toast.LENGTH_LONG).show();
        } catch (IOException e) {
            Toast.makeText(this, R.string.alert_save_failed, Toast.LENGTH_LONG).show();
        }
    }

    private void preview() {
        try {
            read();
            AlarmActivity.preview(this, alert);
        } catch (IllegalArgumentException | JSONException e) {
            Toast.makeText(this, e.getMessage(), Toast.LENGTH_LONG).show();
        }
    }

    private void pick(int code, String... types) {
        if (copying) return;
        startActivityForResult(new Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("*/*")
                .putExtra(Intent.EXTRA_MIME_TYPES, types), code);
    }

    /** Copies the picked file into Still's folder off the main thread, like alert-media on Windows. */
    @Override
    protected void onActivityResult(int code, int result, Intent data) {
        if (result != RESULT_OK || data == null || data.getData() == null) return;
        Uri uri = data.getData();
        String name = uri.getLastPathSegment(), ext = null;
        long size = -1;
        try (Cursor c = getContentResolver().query(uri, new String[] { OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE }, null, null, null)) {
            if (c != null && c.moveToFirst()) {
                if (!c.isNull(0)) name = c.getString(0);
                if (!c.isNull(1)) size = c.getLong(1);
            }
        } catch (RuntimeException ignored) { }
        if (name != null && name.lastIndexOf('.') > 0) ext = name.substring(name.lastIndexOf('.') + 1).toLowerCase(Locale.ROOT);
        List<String> allowed = code == PICK_SOUND ? SOUND_TYPES : BANNER_TYPES;
        if (ext == null || !allowed.contains(ext)) ext = MimeTypeMap.getSingleton().getExtensionFromMimeType(getContentResolver().getType(uri));
        if (ext == null || !allowed.contains(ext)) { Toast.makeText(this, R.string.alert_media_type, Toast.LENGTH_LONG).show(); return; }
        if (size > MAX_MEDIA_BYTES) { Toast.makeText(this, R.string.alert_media_size, Toast.LENGTH_LONG).show(); return; }
        String file = UUID.randomUUID() + "." + ext, shown = name == null ? file : name.substring(0, Math.min(200, name.length()));
        File target = AlertStore.media(this, file);
        copying = true;
        new Thread(() -> {
            boolean ok = copy(uri, target);
            runOnUiThread(() -> {
                copying = false;
                if (!ok) { target.delete(); Toast.makeText(this, R.string.alert_media_failed, Toast.LENGTH_LONG).show(); return; }
                if (isDestroyed()) return;
                if (code == PICK_SOUND) { alert.soundFile = file; alert.soundName = shown; }
                else { alert.banner = file; alert.bannerName = shown; }
                update();
            });
        }).start();
    }

    private boolean copy(Uri uri, File target) {
        target.getParentFile().mkdirs();
        try (InputStream in = getContentResolver().openInputStream(uri); OutputStream out = new FileOutputStream(target)) {
            byte[] buffer = new byte[64 * 1024];
            long total = 0;
            for (int n; (n = in.read(buffer)) > 0; ) {
                total += n;
                if (total > MAX_MEDIA_BYTES) return false;
                out.write(buffer, 0, n);
            }
            return total > 0;
        } catch (IOException | RuntimeException e) {
            return false;
        }
    }
}

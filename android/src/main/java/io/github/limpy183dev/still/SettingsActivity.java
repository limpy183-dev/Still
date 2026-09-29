package io.github.limpy183dev.still;

import android.app.AlertDialog;
import android.os.Bundle;
import android.widget.Button;
import android.widget.CompoundButton;
import android.widget.Toast;

/** Settings, like the desktop Settings page: Reminders count as focus, and the Made to fit you options. */
public final class SettingsActivity extends StillActivity {
    static final String COUNT_ALARM_FOCUS = "countAlarmFocus";
    private static final int[] SWITCHES = { R.id.high_contrast, R.id.readable_font, R.id.strong_focus, R.id.reduced_motion };
    private static final String[] KEYS = { HIGH_CONTRAST, READABLE_FONT, STRONG_FOCUS, REDUCED_MOTION };

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        setContentView(R.layout.activity_settings);
        CompoundButton count = findViewById(R.id.count_alarm_focus);
        count.setChecked(settings(this).getBoolean(COUNT_ALARM_FOCUS, false));
        count.setOnCheckedChangeListener((box, on) -> settings(this).edit().putBoolean(COUNT_ALARM_FOCUS, on).apply());
        for (int i = 0; i < SWITCHES.length; i++) {
            String key = KEYS[i];
            CompoundButton option = findViewById(SWITCHES[i]);
            option.setChecked(settings(this).getBoolean(key, false));
            option.setOnCheckedChangeListener((box, on) -> { settings(this).edit().putBoolean(key, on).apply(); changed(); });
        }
        Button size = findViewById(R.id.text_size);
        String[] names = getResources().getStringArray(R.array.text_sizes);
        int chosen = java.util.Arrays.binarySearch(TEXT_SIZES, textSize(this));
        size.setText(names[chosen]);
        size.setContentDescription(getString(R.string.text_size_a11y, names[chosen]));
        size.setOnClickListener(v -> new AlertDialog.Builder(this).setTitle(R.string.text_size)
                .setSingleChoiceItems(names, chosen, (d, which) -> {
                    d.dismiss();
                    if (which == chosen) return;
                    settings(this).edit().putInt(TEXT_SIZE, TEXT_SIZES[which]).apply();
                    changed();
                })
                .setNegativeButton(R.string.cancel, null).show());
        findViewById(R.id.a11y_reset).setOnClickListener(v -> {
            settings(this).edit().remove(TEXT_SIZE).remove(HIGH_CONTRAST).remove(READABLE_FONT)
                    .remove(STRONG_FOCUS).remove(REDUCED_MOTION).apply();
            changed();
            Toast.makeText(this, R.string.a11y_reset_done, Toast.LENGTH_SHORT).show();
        });
        Nav.attach(this, Nav.SETTINGS);
    }

    @Override
    protected void onResume() {
        super.onResume();
        Nav.resumed(this);
    }

    /** Applies a saved option straight away: this page now, the pages behind it when they're next shown. */
    private void changed() {
        generation++;
        recreate();
    }
}

package io.github.limpy183dev.still;

import android.app.Activity;
import android.app.AlertDialog;
import android.app.TimePickerDialog;
import android.os.Bundle;
import android.text.InputType;
import android.text.format.DateFormat;
import android.view.View;
import android.widget.Button;
import android.widget.CheckBox;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

import java.time.LocalTime;

/** Daily website limits and bedtime. Changes apply at once, whether or not a focus session is running. */
public final class LimitsActivity extends Activity {
    private Limits limits;
    private CheckBox bedtimeOn;
    private Button from, to;
    private EditText input;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        setContentView(R.layout.activity_limits);
        limits = LimitStore.limits(this);
        bedtimeOn = findViewById(R.id.bedtime_on);
        from = findViewById(R.id.bedtime_from);
        to = findViewById(R.id.bedtime_to);
        input = findViewById(R.id.limit_input);

        bedtimeOn.setChecked(limits.bedtimeOn);
        bedtimeOn.setOnCheckedChangeListener((box, on) -> {
            limits.setBedtime(on, limits.from, limits.to);
            save();
        });
        from.setOnClickListener(v -> pickTime(true));
        to.setOnClickListener(v -> pickTime(false));
        findViewById(R.id.limit_add).setOnClickListener(v -> addTyped());
        input.setOnEditorActionListener((view, action, event) -> { addTyped(); return true; });
        render();
    }

    @Override
    protected void onResume() {
        super.onResume();
        findViewById(R.id.need_blocking).setVisibility(Device.blockingEnabled(this) ? View.GONE : View.VISIBLE);
        render(); // Usage may have grown while away.
    }

    private void save() {
        LimitStore.save(this, limits);
        render();
    }

    private void render() {
        from.setText(Store.clockText(this, limits.from));
        to.setText(Store.clockText(this, limits.to));
        from.setEnabled(limits.bedtimeOn);
        to.setEnabled(limits.bedtimeOn);

        LinearLayout rows = findViewById(R.id.limit_rows);
        rows.removeAllViews();
        int pad = Math.round(12 * getResources().getDisplayMetrics().density);
        for (Limits.Site site : limits.sites()) {
            String summary = site.minutes > 0
                    ? getString(R.string.limit_summary_minutes, site.minutes, LimitStore.secondsUsed(this, site.domain) / 60)
                    : getString(R.string.limit_summary_none);
            if (site.bedtime) summary = getString(R.string.limit_summary_bedtime, summary);
            TextView row = new TextView(this, null, 0, R.style.Body);
            row.setText(getString(R.string.limit_row, site.domain, summary));
            row.setPadding(0, pad, 0, pad);
            row.setOnClickListener(v -> edit(site.domain, site.minutes, site.bedtime, true));
            rows.addView(row);
        }
        if (limits.sites().isEmpty()) {
            TextView none = new TextView(this, null, 0, R.style.Hint);
            none.setText(R.string.limits_none);
            none.setPadding(0, pad, 0, pad);
            rows.addView(none);
        }

        LinearLayout suggestions = findViewById(R.id.suggestions);
        suggestions.removeAllViews();
        for (String domain : Limits.RECOMMENDED) {
            if (limits.find(domain) != null) continue;
            Button add = new Button(this, null, 0, R.style.Secondary);
            add.setText(getString(R.string.suggest_add, domain));
            add.setAllCaps(false);
            add.setOnClickListener(v -> edit(domain, 30, true, false));
            suggestions.addView(add);
        }
        boolean anySuggestion = suggestions.getChildCount() > 0;
        findViewById(R.id.suggestions_label).setVisibility(anySuggestion ? View.VISIBLE : View.GONE);
    }

    private void addTyped() {
        String text = input.getText().toString().trim();
        if (text.isEmpty()) return;
        try {
            String domain = Websites.domain(text);
            Limits.Site existing = limits.find(domain);
            if (existing != null && existing.domain.equals(domain)) edit(domain, existing.minutes, existing.bedtime, true);
            else edit(domain, 30, true, false);
            input.setText("");
        } catch (IllegalArgumentException e) {
            Toast.makeText(this, e.getMessage(), Toast.LENGTH_LONG).show();
        }
    }

    private void edit(String domain, int minutes, boolean bedtime, boolean existing) {
        int pad = Math.round(24 * getResources().getDisplayMetrics().density);
        LinearLayout form = new LinearLayout(this);
        form.setOrientation(LinearLayout.VERTICAL);
        form.setPadding(pad, pad / 2, pad, 0);
        EditText minutesInput = new EditText(this);
        minutesInput.setInputType(InputType.TYPE_CLASS_NUMBER);
        minutesInput.setHint(R.string.limit_minutes);
        minutesInput.setText(String.valueOf(minutes));
        minutesInput.setContentDescription(getString(R.string.limit_minutes));
        TextView label = new TextView(this, null, 0, R.style.Hint);
        label.setText(R.string.limit_minutes);
        CheckBox rest = new CheckBox(this);
        rest.setText(R.string.limit_bedtime);
        rest.setChecked(bedtime);
        form.addView(label);
        form.addView(minutesInput);
        form.addView(rest);

        AlertDialog.Builder dialog = new AlertDialog.Builder(this).setTitle(domain).setView(form)
                .setPositiveButton(R.string.save, (d, w) -> {
                    int value;
                    try {
                        value = Integer.parseInt(minutesInput.getText().toString().trim());
                    } catch (NumberFormatException e) {
                        value = 0;
                    }
                    try {
                        limits.put(domain, value, rest.isChecked());
                        save();
                    } catch (IllegalArgumentException e) {
                        Toast.makeText(this, e.getMessage(), Toast.LENGTH_LONG).show();
                    }
                })
                .setNegativeButton(R.string.cancel, null);
        if (existing) dialog.setNeutralButton(R.string.remove, (d, w) -> {
            limits.remove(domain);
            save();
        });
        dialog.show();
    }

    private void pickTime(boolean start) {
        LocalTime at = LocalTime.parse(start ? limits.from : limits.to);
        new TimePickerDialog(this, (picker, hour, minute) -> {
            String value = String.format(java.util.Locale.ROOT, "%02d:%02d", hour, minute);
            limits.setBedtime(limits.bedtimeOn, start ? value : limits.from, start ? limits.to : value);
            save();
        }, at.getHour(), at.getMinute(), DateFormat.is24HourFormat(this)).show();
    }
}

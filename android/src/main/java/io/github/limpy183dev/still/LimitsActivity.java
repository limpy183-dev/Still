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
import android.widget.CompoundButton;
import android.view.Gravity;
import android.view.ViewGroup;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

import java.time.LocalTime;

/** Daily website limits and bedtime. Changes apply at once, whether or not a focus session is running. */
public final class LimitsActivity extends Activity {
    private Limits limits;
    private CompoundButton bedtimeOn;
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
        Nav.attach(this, Nav.LIMITS);
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
        float dp = getResources().getDisplayMetrics().density;
        int pad = Math.round(12 * dp);
        for (Limits.Site site : limits.sites()) {
            String summary = site.minutes > 0
                    ? getString(R.string.limit_summary_minutes, site.minutes, LimitStore.secondsUsed(this, site.domain) / 60)
                    : getString(R.string.limit_summary_none);
            if (site.bedtime) summary = getString(R.string.limit_summary_bedtime, summary);
            rows.addView(row(site.domain, summary, dp));
            rows.getChildAt(rows.getChildCount() - 1).setOnClickListener(v -> edit(site.domain, site.minutes, site.bedtime, true));
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
            add.setOnClickListener(v -> edit(domain, 30, true, false));
            LinearLayout.LayoutParams gap = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
            gap.setMarginEnd(pad / 2);
            suggestions.addView(add, gap);
        }
        boolean anySuggestion = suggestions.getChildCount() > 0;
        findViewById(R.id.suggestions_label).setVisibility(anySuggestion ? View.VISIBLE : View.GONE);
    }

    /** A website like .app-row: its initial in a soft tile, the name and today's use, and a chevron to edit. */
    private View row(String domain, String summary, float dp) {
        LinearLayout row = new LinearLayout(this);
        row.setGravity(Gravity.CENTER_VERTICAL);
        row.setBackgroundResource(R.drawable.row_line);
        int pad = Math.round(12 * dp);
        row.setPadding(0, pad, 0, pad);
        TextView tile = new TextView(this, null, 0, R.style.CardTitle);
        tile.setText(domain.substring(0, 1).toUpperCase(java.util.Locale.ROOT));
        tile.setTextColor(getColor(R.color.green));
        tile.setGravity(Gravity.CENTER);
        tile.setBackgroundResource(R.drawable.soft_box);
        tile.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
        int size = Math.round(38 * dp);
        row.addView(tile, new LinearLayout.LayoutParams(size, size));
        LinearLayout text = new LinearLayout(this);
        text.setOrientation(LinearLayout.VERTICAL);
        text.setPadding(pad, 0, pad, 0);
        TextView name = new TextView(this, null, 0, R.style.Body);
        name.setText(domain);
        name.setTypeface(android.graphics.Typeface.create(name.getTypeface(), 650, false));
        TextView detail = new TextView(this, null, 0, R.style.Hint);
        detail.setText(summary);
        text.addView(name);
        text.addView(detail);
        row.addView(text, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1));
        android.widget.ImageView more = new android.widget.ImageView(this);
        more.setImageResource(R.drawable.ic_chevron);
        more.setImageTintList(getColorStateList(R.color.muted));
        more.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
        row.addView(more);
        row.setContentDescription(getString(R.string.limit_row, domain, summary));
        return row;
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

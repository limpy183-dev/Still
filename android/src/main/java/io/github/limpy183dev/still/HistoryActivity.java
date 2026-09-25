package io.github.limpy183dev.still;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Canvas;
import android.graphics.DashPathEffect;
import android.graphics.Paint;
import android.graphics.Typeface;
import android.os.Bundle;
import android.text.Editable;
import android.text.TextWatcher;
import android.text.format.DateUtils;
import android.view.View;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.RadioGroup;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONException;

import java.io.IOException;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.List;

/** Session history and progress, like "Your progress" on Windows. Figures are computed once per change, never on a timer. */
public final class HistoryActivity extends Activity {
    private static final int EXPORT = 1, PAGE = 20;

    private SharedPreferences prefs;
    private List<History.Record> records = new ArrayList<>();
    private int shown = PAGE;
    private float dp;
    private Chart chart;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        setContentView(R.layout.activity_history);
        dp = getResources().getDisplayMetrics().density;
        prefs = getSharedPreferences("prefs", MODE_PRIVATE);
        chart = new Chart(this);
        ((ViewGroup) findViewById(R.id.history_chart)).addView(chart);

        int days = History.range(prefs.getInt("progressDays", 30));
        RadioGroup range = findViewById(R.id.history_range);
        range.check(days == 7 ? R.id.range_7 : days == 90 ? R.id.range_90 : R.id.range_30);
        range.setOnCheckedChangeListener((group, id) -> {
            prefs.edit().putInt("progressDays", id == R.id.range_7 ? 7 : id == R.id.range_90 ? 90 : 30).apply();
            renderProgress();
        });

        EditText goal = findViewById(R.id.history_goal);
        goal.setText(String.valueOf(History.goal(prefs.getInt("dailyGoal", 60))));
        goal.addTextChangedListener(new TextWatcher() {
            @Override public void beforeTextChanged(CharSequence s, int a, int b, int c) { }
            @Override public void onTextChanged(CharSequence s, int a, int b, int c) { }
            @Override public void afterTextChanged(Editable s) {
                // Out-of-range values are ignored until corrected, like the number field on Windows.
                int minutes;
                try { minutes = Integer.parseInt(s.toString()); } catch (NumberFormatException e) { return; }
                if (minutes != History.goal(minutes)) return;
                prefs.edit().putInt("dailyGoal", minutes).apply();
                renderProgress();
            }
        });

        RadioGroup filter = findViewById(R.id.history_filter);
        filter.check(R.id.filter_active);
        filter.setOnCheckedChangeListener((group, id) -> { shown = PAGE; renderList(); });
        findViewById(R.id.history_more).setOnClickListener(v -> { shown += PAGE; renderList(); });
        findViewById(R.id.history_export).setOnClickListener(v -> startActivityForResult(
                new Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("application/json")
                        .putExtra(Intent.EXTRA_TITLE, "Still-sessions.json"), EXPORT));
        Nav.attach(this, Nav.PROGRESS);
    }

    @Override
    protected void onResume() {
        super.onResume();
        render();
    }

    private void render() {
        records = Store.records(this);
        renderStats();
        renderProgress();
        renderList();
    }

    /** .stats-row: all focus time, completed sessions, and the last seven days. */
    private void renderStats() {
        long now = System.currentTimeMillis(), total = 0;
        int completed = 0;
        for (History.Record r : records) {
            total += History.focusMs(r, 0, now, now);
            if ("completed".equals(r.outcome)) completed++;
        }
        double week = 0;
        for (History.Day d : History.days(records, 7, LocalDate.now(), ZoneId.systemDefault(), now)) week += d.minutes;
        ((TextView) findViewById(R.id.stat_total)).setText(History.readable(total / 60000));
        ((TextView) findViewById(R.id.stat_completed)).setText(String.valueOf(completed));
        ((TextView) findViewById(R.id.stat_week)).setText(History.readable((long) week));
    }

    private void renderProgress() {
        int count = History.range(prefs.getInt("progressDays", 30)), goal = History.goal(prefs.getInt("dailyGoal", 60));
        long now = System.currentTimeMillis();
        List<History.Day> days = History.days(records, count, LocalDate.now(), ZoneId.systemDefault(), now);
        int[] s = History.summary(records, days, goal, now);
        ((TextView) findViewById(R.id.history_summary)).setText(getString(R.string.history_summary, s[0], count, s[1],
                s[2] < 0 ? "–" : s[2] + "%", History.readable(s[3])));

        float[] minutes = new float[days.size()];
        float max = 1;
        for (int i = 0; i < minutes.length; i++) max = Math.max(max, minutes[i] = (float) days.get(i).minutes);
        chart.set(minutes, goal);
        chart.setContentDescription(getString(R.string.history_chart, count, Math.round(Math.floor(minutes[minutes.length - 1])), goal));
        ((TextView) findViewById(R.id.history_scale)).setText(getString(R.string.history_scale,
                (int) Math.ceil(Math.max(max, goal)), shortDate(days.get(0).start), shortDate(days.get(days.size() - 1).start)));

        List<History.Group> groups = History.intentions(records, days.get(0).start, now);
        LinearLayout rows = findViewById(R.id.history_intentions);
        rows.removeAllViews();
        double total = 0, top = 1;
        for (History.Group g : groups) { total += g.minutes; top = Math.max(top, g.minutes); }
        ((TextView) findViewById(R.id.history_intentions_total)).setText(groups.isEmpty() ? getString(R.string.history_no_intentions)
                : getResources().getQuantityString(R.plurals.history_intentions_total, groups.size(),
                        History.readable((long) total), groups.size()));
        for (History.Group g : groups) {
            TextView name = text(R.style.Body, g.label);
            name.setPadding(0, Math.round(12 * dp), 0, 0);
            rows.addView(name);
            rows.addView(text(R.style.Hint, getResources().getQuantityString(R.plurals.history_intention_meta, g.sessions,
                    g.sessions, shortDate(g.last), History.readable((long) g.minutes))));
            ProgressBar bar = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
            bar.setProgressTintList(getColorStateList(R.color.ring_running));
            bar.setProgressBackgroundTintList(getColorStateList(R.color.line));
            bar.setMax(1000);
            bar.setProgress((int) Math.max(1, g.minutes / top * 1000));
            bar.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
            rows.addView(bar);
        }
    }

    /** ponytail: builds rows in pages of 20 rather than a recycling list; 500 records max keeps this cheap. */
    private void renderList() {
        int filter = ((RadioGroup) findViewById(R.id.history_filter)).getCheckedRadioButtonId();
        List<History.Record> visible = new ArrayList<>();
        for (History.Record r : records) {
            if (r.outcome == null) continue; // The running session isn't history yet.
            if (filter == R.id.filter_all || r.archived == (filter == R.id.filter_archived)) visible.add(r);
        }
        LinearLayout rows = findViewById(R.id.history_rows);
        rows.removeAllViews();
        if (visible.isEmpty()) rows.addView(text(R.style.Hint, getString(R.string.history_empty)));
        for (History.Record r : visible.subList(0, Math.min(shown, visible.size()))) rows.addView(row(r));
        findViewById(R.id.history_more).setVisibility(visible.size() > shown ? View.VISIBLE : View.GONE);
    }

    private View row(History.Record r) {
        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.VERTICAL);
        row.setPadding(0, Math.round(14 * dp), 0, Math.round(6 * dp));
        row.setBackgroundResource(R.drawable.row_line);
        TextView title = text(R.style.Body, History.label(r));
        title.setTypeface(Typeface.create(title.getTypeface(), 650, false));
        row.addView(title);
        long minutes = History.focusMs(r, 0, Long.MAX_VALUE, System.currentTimeMillis()) / 60000;
        row.addView(text(R.style.Hint, getString(R.string.history_meta, shortDate(r.startedAt), Store.time(this, r.startedAt),
                History.readable(minutes), getString(outcome(r.outcome)),
                getResources().getQuantityString(R.plurals.history_targets, r.targets, r.targets))));
        LinearLayout actions = new LinearLayout(this);
        actions.addView(button(r.archived ? R.string.history_restore : R.string.history_archive, r,
                v -> update(r, r.archived ? "restore" : "archive")));
        actions.addView(button(R.string.history_delete, r, v -> new AlertDialog.Builder(this)
                .setTitle(R.string.history_delete_title)
                .setMessage(getString(R.string.history_delete_text, History.label(r)))
                .setPositiveButton(R.string.history_delete_confirm, (d, w) -> update(r, "delete"))
                .setNegativeButton(R.string.cancel, null).show()));
        row.addView(actions);
        return row;
    }

    private Button button(int label, History.Record r, View.OnClickListener click) {
        Button b = new Button(this, null, 0, R.style.TextButton);
        b.setText(label);
        b.setContentDescription(getString(label) + ", " + History.label(r) + ", " + shortDate(r.startedAt));
        b.setOnClickListener(click);
        return b;
    }

    private void update(History.Record r, String action) {
        try {
            Store.updateHistory(this, r.id, action);
            Toast.makeText(this, "delete".equals(action) ? R.string.history_deleted
                    : "archive".equals(action) ? R.string.history_archived_toast : R.string.history_restored, Toast.LENGTH_SHORT).show();
        } catch (IOException e) {
            Toast.makeText(this, R.string.history_save_failed, Toast.LENGTH_LONG).show();
        }
        render();
    }

    @Override
    protected void onActivityResult(int code, int result, Intent data) {
        if (code != EXPORT || result != RESULT_OK || data == null || data.getData() == null) return;
        try (OutputStream out = getContentResolver().openOutputStream(data.getData(), "wt")) {
            if (out == null) throw new IOException("No output");
            // The same JSON as Export history on Windows: the saved records, indented by two spaces.
            out.write(Store.history(this).toString(2).getBytes(StandardCharsets.UTF_8));
            Toast.makeText(this, R.string.history_exported, Toast.LENGTH_SHORT).show();
        } catch (IOException | JSONException | RuntimeException e) {
            Toast.makeText(this, R.string.history_export_failed, Toast.LENGTH_LONG).show();
        }
    }

    private static int outcome(String outcome) {
        if ("completed".equals(outcome)) return R.string.outcome_completed;
        if ("ended-early".equals(outcome)) return R.string.outcome_early;
        if ("snoozed".equals(outcome)) return R.string.outcome_snoozed;
        return R.string.outcome_recovered;
    }

    private String shortDate(long at) {
        return DateUtils.formatDateTime(this, at, DateUtils.FORMAT_SHOW_DATE | DateUtils.FORMAT_ABBREV_MONTH | DateUtils.FORMAT_NO_YEAR);
    }

    private TextView text(int style, String value) {
        TextView view = new TextView(this, null, 0, style);
        view.setText(value);
        return view;
    }

    /** Daily focus minutes as bars, with the daily goal as a dashed line. */
    static final class Chart extends View {
        private final Paint bar = new Paint(Paint.ANTI_ALIAS_FLAG), empty = new Paint(), goalLine = new Paint(Paint.ANTI_ALIAS_FLAG);
        private float[] values = new float[0];
        private float goal;

        Chart(Context c) {
            super(c);
            float dp = c.getResources().getDisplayMetrics().density;
            bar.setColor(c.getColor(R.color.ring_running)); // .trend-bar
            empty.setColor(c.getColor(R.color.line));
            goalLine.setColor(c.getColor(R.color.muted));
            goalLine.setStyle(Paint.Style.STROKE);
            goalLine.setStrokeWidth(dp);
            goalLine.setPathEffect(new DashPathEffect(new float[] { 4 * dp, 4 * dp }, 0));
        }

        void set(float[] values, float goal) {
            this.values = values;
            this.goal = goal;
            invalidate();
        }

        @Override
        protected void onDraw(Canvas canvas) {
            if (values.length == 0) return;
            float max = goal, w = getWidth(), h = getHeight(), slot = w / values.length, gap = Math.min(slot * 0.25f, 4 * getResources().getDisplayMetrics().density);
            for (float v : values) max = Math.max(max, v);
            for (int i = 0; i < values.length; i++) {
                float top = h - Math.max(2, values[i] / max * h), left = i * slot + gap / 2;
                float r = Math.min(4 * getResources().getDisplayMetrics().density, (slot - gap) / 2);
                canvas.drawRoundRect(left, top, left + slot - gap, h + r, r, r, values[i] > 0 ? bar : empty); // Rounded top only.
            }
            float y = h - goal / max * h + goalLine.getStrokeWidth() / 2;
            canvas.drawLine(0, y, w, y, goalLine);
        }
    }
}

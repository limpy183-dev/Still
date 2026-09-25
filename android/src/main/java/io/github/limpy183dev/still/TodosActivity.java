package io.github.limpy183dev.still;

import android.app.Activity;
import android.content.Context;
import android.content.SharedPreferences;
import android.graphics.Paint;
import android.graphics.Typeface;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.Editable;
import android.text.InputFilter;
import android.text.InputType;
import android.text.TextWatcher;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.inputmethod.EditorInfo;
import android.widget.ArrayAdapter;
import android.widget.CheckBox;
import android.widget.CompoundButton;
import android.widget.EditText;
import android.widget.ImageButton;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ListPopupWindow;
import android.widget.PopupWindow;
import android.widget.RadioButton;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

/** The to-do list. Edits save automatically, including during focus sessions, like on Windows. */
public final class TodosActivity extends Activity {
    private static final long SAVE_DELAY_MS = 400;

    private final Todos todos = new Todos();
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final Runnable save = this::save;
    private LinearLayout rows;
    private TextView progress;
    private ListPopupWindow menu;
    private List<Todos.Format> menuOptions = new ArrayList<>();
    private EditText menuInput;
    private Todos.Item menuItem;
    private float dp;

    /** Same JSON shape as prefs.todos on Windows, and the same limits as validatePreferences. */
    static List<Todos.Item> load(Context c) {
        List<Todos.Item> out = new ArrayList<>();
        try {
            JSONArray saved = new JSONArray(prefs(c).getString("todos", "[]"));
            for (int i = 0; i < saved.length() && out.size() < Todos.MAX_LINES; i++) {
                JSONObject o = saved.optJSONObject(i);
                if (o != null && o.opt("text") instanceof String)
                    out.add(new Todos.Item(o.optString("type"), o.optString("text"), o.optBoolean("done")));
            }
        } catch (JSONException damaged) { } // A damaged list starts fresh rather than blocking the screen.
        return out;
    }

    private static SharedPreferences prefs(Context c) { return c.getSharedPreferences("todos", MODE_PRIVATE); }

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        setContentView(R.layout.activity_todos);
        dp = getResources().getDisplayMetrics().density;
        rows = findViewById(R.id.todo_rows);
        progress = findViewById(R.id.todo_progress);
        todos.load(load(this));
        findViewById(R.id.todo_add).setOnClickListener(v -> {
            if (!todos.add(todos.items.size(), "checkbox", "")) { full(); return; }
            render(todos.items.size() - 1, 0);
            changed();
        });
        render(-1, 0);
        Nav.attach(this, Nav.TODOS);
    }

    @Override
    protected void onPause() {
        super.onPause();
        if (menu != null) menu.dismiss();
        handler.removeCallbacks(save);
        save();
    }

    private void changed() {
        progress.setText(todos.progress());
        handler.removeCallbacks(save);
        handler.postDelayed(save, SAVE_DELAY_MS);
    }

    private void save() {
        JSONArray out = new JSONArray();
        try {
            for (Todos.Item item : todos.items) out.put(new JSONObject().put("text", item.text).put("type", item.type).put("done", item.done));
        } catch (JSONException e) {
            return;
        }
        prefs(this).edit().putString("todos", out.toString()).apply();
    }

    private void full() {
        Toast.makeText(this, R.string.todo_full, Toast.LENGTH_LONG).show();
    }

    /**
     * Rebuilds the rows after a change to the list's shape (typing never rebuilds).
     * ponytail: rebuilds every row; fine for everyday lists, a recycling list if 500-line lists feel slow.
     */
    private void render(int focus, int cursor) {
        if (menu != null) menu.dismiss();
        rows.removeAllViews();
        for (int i = 0; i < todos.items.size(); i++) rows.addView(row(todos.items.get(i), i));
        progress.setText(todos.progress());
        if (focus >= 0 && focus < rows.getChildCount()) {
            EditText input = rows.getChildAt(focus).findViewWithTag("input");
            input.requestFocus();
            input.setSelection(Math.min(cursor, input.length()));
        }
    }

    private View row(Todos.Item item, int index) {
        LinearLayout row = new LinearLayout(this);
        row.setGravity(Gravity.CENTER_VERTICAL);
        row.setMinimumHeight(Math.round(52 * dp));
        row.setBackgroundResource(R.drawable.row_line);
        boolean task = Todos.isTask(item.type), heading = "heading".equals(item.type);

        View mark;
        if (task) {
            CompoundButton box = "circle".equals(item.type) ? new RadioButton(this) : new CheckBox(this);
            box.setChecked(item.done);
            box.setContentDescription(getString(R.string.todo_complete, index + 1));
            // A click sets the model first; a RadioButton can't uncheck itself, so the view follows the model.
            box.setOnClickListener(v -> {
                todos.toggle(todos.items.indexOf(item));
                box.setChecked(item.done);
                styleDone(row, item);
                changed();
            });
            mark = box;
        } else {
            TextView marker = new TextView(this, null, 0, R.style.Hint);
            marker.setGravity(Gravity.CENTER);
            marker.setTextSize(heading ? 18 : 16);
            marker.setText("number".equals(item.type) ? todos.numberAt(index) + "." : "bullet".equals(item.type) ? "•" : heading ? "H" : "—");
            marker.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
            mark = marker;
        }
        row.addView(mark, new LinearLayout.LayoutParams(Math.round(40 * dp), ViewGroup.LayoutParams.WRAP_CONTENT));

        EditText input = new EditText(this);
        input.setTag("input");
        input.setText(item.text);
        input.setBackground(null);
        input.setPadding(0, Math.round(12 * dp), 0, Math.round(12 * dp));
        input.setTextSize(heading ? 20 : 16);
        if (heading) input.setTypeface(Typeface.create(input.getTypeface(), 700, false));
        if ("note".equals(item.type)) input.setTextColor(getColor(R.color.muted));
        input.setHint(heading ? R.string.todo_heading_hint : R.string.todo_hint);
        input.setFilters(new InputFilter[] { new InputFilter.LengthFilter(Todos.MAX_TEXT) });
        // Wraps like a paragraph, but Enter is an action, so it starts a new line instead of a line break.
        input.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_CAP_SENTENCES);
        input.setHorizontallyScrolling(false);
        input.setMaxLines(Integer.MAX_VALUE);
        input.setImeOptions(EditorInfo.IME_ACTION_NEXT | EditorInfo.IME_FLAG_NO_EXTRACT_UI);
        input.setContentDescription(getString(R.string.todo_line, index + 1, formatName(item.type)));
        input.addTextChangedListener(new TextWatcher() {
            @Override public void beforeTextChanged(CharSequence s, int a, int b, int c) { }
            @Override public void onTextChanged(CharSequence s, int a, int b, int c) { }
            @Override public void afterTextChanged(Editable s) {
                item.text = s.toString();
                changed();
                showMenu(input, item);
            }
        });
        // On-screen keyboards send Enter as an editor action; hardware keyboards send key events below.
        input.setOnEditorActionListener((view, action, event) -> {
            split(input, item);
            return true;
        });
        input.setOnKeyListener((view, key, event) -> {
            if (key == KeyEvent.KEYCODE_ENTER || key == KeyEvent.KEYCODE_NUMPAD_ENTER) {
                // Split on key down; swallow key up, which would otherwise reach the new line and move focus on.
                if (event.getAction() == KeyEvent.ACTION_DOWN) split(input, item);
                return true;
            }
            if (key != KeyEvent.KEYCODE_DEL || event.getAction() != KeyEvent.ACTION_DOWN || input.length() > 0) return false;
            int at = todos.items.indexOf(item);
            if (!todos.removeIfEmpty(at)) return false;
            int previous = Math.max(0, at - 1);
            render(previous, todos.items.get(previous).text.length());
            changed();
            return true;
        });
        row.addView(input, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1));

        ImageButton delete = new ImageButton(this);
        delete.setImageResource(R.drawable.ic_close);
        delete.setImageTintList(getColorStateList(R.color.muted));
        delete.setScaleType(ImageView.ScaleType.CENTER);
        delete.setBackground(null);
        delete.setAlpha(0.6f);
        delete.setContentDescription(getString(R.string.todo_delete, index + 1));
        delete.setOnClickListener(v -> {
            int at = todos.items.indexOf(item);
            todos.delete(at);
            render(Math.min(at, todos.items.size() - 1), 0);
            changed();
        });
        row.addView(delete, new LinearLayout.LayoutParams(Math.round(48 * dp), Math.round(48 * dp)));
        styleDone(row, item);
        return row;
    }

    /** Enter: the text after the cursor moves to a new line. */
    private void split(EditText input, Todos.Item item) {
        int at = todos.items.indexOf(item);
        if (!todos.split(at, input.getSelectionStart(), input.getSelectionEnd())) { full(); return; }
        render(at + 1, 0);
        changed();
    }

    private void styleDone(LinearLayout row, Todos.Item item) {
        EditText input = row.findViewWithTag("input");
        if (input == null) return;
        boolean done = Todos.isTask(item.type) && item.done;
        input.setPaintFlags(done ? input.getPaintFlags() | Paint.STRIKE_THRU_TEXT_FLAG : input.getPaintFlags() & ~Paint.STRIKE_THRU_TEXT_FLAG);
        input.setAlpha(done ? 0.55f : 1f);
    }

    private static String formatName(String type) {
        for (Todos.Format f : Todos.FORMATS) if (f.type.equals(type)) return f.name;
        return type;
    }

    /** The "/" menu: typing "/" at the start of a line or after a space lists the formats, filtered as you type. */
    private void showMenu(EditText input, Todos.Item item) {
        String query = input.hasFocus() ? Todos.menuQuery(input.getText().toString(), input.getSelectionEnd()) : null;
        if (query == null) {
            if (menu != null) menu.dismiss();
            return;
        }
        menuOptions = Todos.matching(query);
        menuInput = input;
        menuItem = item;
        List<String> labels = new ArrayList<>();
        for (Todos.Format f : menuOptions) labels.add(f.mark + "   " + f.name + "\n      " + f.description);
        if (labels.isEmpty()) labels.add(getString(R.string.todo_no_format));
        if (menu == null) {
            menu = new ListPopupWindow(this);
            menu.setModal(false);
            menu.setInputMethodMode(PopupWindow.INPUT_METHOD_NEEDED);
            TextView title = new TextView(this, null, 0, R.style.Label);
            title.setText(R.string.todo_menu_title);
            int pad = Math.round(16 * dp);
            title.setPadding(pad, pad, pad, pad / 2);
            menu.setPromptView(title);
            // Set once: the popup keeps the listener it was built with, so it reads the current options.
            menu.setOnItemClickListener((parent, view, position, id) -> {
                if (position >= menuOptions.size()) return;
                int at = todos.items.indexOf(menuItem);
                if (at < 0) return;
                int cursor = todos.choose(at, menuInput.getSelectionEnd(), menuOptions.get(position).type);
                render(at, cursor);
                changed();
            });
        }
        menu.setAnchorView(input);
        menu.setWidth(Math.round(300 * dp));
        menu.setAdapter(new ArrayAdapter<>(this, android.R.layout.simple_list_item_1, labels));
        menu.show();
    }
}

package io.github.limpy183dev.still;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * The to-do list, mirroring app/todos.js and the todos rules in app/domain.cjs: the same line formats,
 * "/" menu, Enter and Backspace behaviour, and limits (500 lines of 2,000 characters). Pure Java.
 */
final class Todos {
    static final int MAX_LINES = 500, MAX_TEXT = 2000;

    static final class Format {
        final String type, mark, name, description, keywords;
        Format(String type, String mark, String name, String description, String keywords) {
            this.type = type; this.mark = mark; this.name = name; this.description = description; this.keywords = keywords;
        }
    }

    static final Format[] FORMATS = {
        new Format("checkbox", "☐", "Checkbox", "A satisfying little tick", "task tickbox square"),
        new Format("circle", "○", "Tick circle", "A softer way to check things off", "task tickcircle round"),
        new Format("bullet", "•", "Bullet list", "Ideas without a particular order", "unordered dot"),
        new Format("number", "1.", "Numbered list", "Steps to take in sequence", "ordered steps"),
        new Format("heading", "H", "Heading", "Give a few lines a shared purpose", "title section"),
        new Format("note", "≡", "Note", "A thought or a little context", "text paragraph plain"),
    };

    static final class Item {
        String type, text;
        boolean done;
        Item(String type, String text, boolean done) {
            this.type = validType(type) ? type : "checkbox";
            this.text = text == null ? "" : text.substring(0, Math.min(MAX_TEXT, text.length()));
            this.done = done && isTask(this.type);
        }
    }

    final List<Item> items = new ArrayList<>();

    Todos() { items.add(new Item("checkbox", "", false)); }

    static boolean validType(String type) {
        for (Format f : FORMATS) if (f.type.equals(type)) return true;
        return false;
    }

    static boolean isTask(String type) { return "checkbox".equals(type) || "circle".equals(type); }

    /** Loads saved lines with the same limits as validatePreferences; an empty list gets one fresh line. */
    void load(List<Item> saved) {
        items.clear();
        for (Item item : saved) if (items.size() < MAX_LINES) items.add(item);
        if (items.isEmpty()) items.add(new Item("checkbox", "", false));
    }

    /** "2 OF 5 COMPLETE", or "A FRESH PAGE" when there are no tasks. */
    String progress() {
        int tasks = 0, done = 0;
        for (Item item : items) if (isTask(item.type)) { tasks++; if (item.done) done++; }
        return tasks == 0 ? "A FRESH PAGE" : done + " OF " + tasks + " COMPLETE";
    }

    /** The number shown before a numbered line; numbering restarts after any other kind of line. */
    int numberAt(int index) {
        int n = 0;
        for (int i = 0; i <= index; i++) n = "number".equals(items.get(i).type) ? n + 1 : 0;
        return n;
    }

    /** Inserts a line; false when the list is full. */
    boolean add(int index, String type, String text) {
        if (items.size() >= MAX_LINES) return false;
        items.add(index, new Item(type, text, false));
        return true;
    }

    /** Enter: the text after the cursor moves to a new line of the same kind (a heading is followed by a checkbox). */
    boolean split(int index, int start, int end) {
        Item item = items.get(index);
        start = clamp(start, item.text.length());
        end = Math.max(start, clamp(end, item.text.length()));
        if (!add(index + 1, "heading".equals(item.type) ? "checkbox" : item.type, item.text.substring(end))) return false;
        item.text = item.text.substring(0, start);
        return true;
    }

    /** Backspace on an empty line removes it, unless it is the only line. Returns whether it was removed. */
    boolean removeIfEmpty(int index) {
        if (!items.get(index).text.isEmpty() || items.size() <= 1) return false;
        items.remove(index);
        return true;
    }

    /** The delete button: the list always keeps at least one line. */
    void delete(int index) {
        items.remove(index);
        if (items.isEmpty()) items.add(new Item("checkbox", "", false));
    }

    void toggle(int index) {
        Item item = items.get(index);
        if (isTask(item.type)) item.done = !item.done;
    }

    void setText(int index, String text) {
        items.get(index).text = text.substring(0, Math.min(MAX_TEXT, text.length()));
    }

    private static final Pattern SLASH = Pattern.compile("(?:^|\\s)/([^/\\s]*)$");

    /** The "/" query before the cursor ("/che" → "che"), or null when the menu shouldn't open. */
    static String menuQuery(String text, int cursor) {
        Matcher m = SLASH.matcher(text.substring(0, clamp(cursor, text.length())));
        return m.find() ? m.group(1).toLowerCase(Locale.ROOT) : null;
    }

    static List<Format> matching(String query) {
        List<Format> out = new ArrayList<>();
        for (Format f : FORMATS) if ((f.name + " " + f.keywords).toLowerCase(Locale.ROOT).contains(query)) out.add(f);
        return out;
    }

    /** Applies a format chosen from the "/" menu: the "/query" typed is removed. Returns the new cursor position. */
    int choose(int index, int cursor, String type) {
        Item item = items.get(index);
        cursor = clamp(cursor, item.text.length());
        int start = item.text.lastIndexOf('/', cursor - 1);
        if (start < 0) start = cursor;
        item.text = item.text.substring(0, start) + item.text.substring(cursor);
        item.type = type;
        if (!isTask(type)) item.done = false;
        return start;
    }

    private static int clamp(int value, int max) { return Math.max(0, Math.min(max, value)); }
}

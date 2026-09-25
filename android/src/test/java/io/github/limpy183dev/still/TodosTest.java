package io.github.limpy183dev.still;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

/** Behaviour from app/todos.js (and its tests/todos.cjs UI checks). */
public class TodosTest {
    private static Todos list(Todos.Item... items) {
        Todos t = new Todos();
        t.load(Arrays.asList(items));
        return t;
    }

    @Test public void startsWithOneFreshLine() {
        Todos t = list();
        assertEquals(1, t.items.size());
        assertEquals("checkbox", t.items.get(0).type);
        assertEquals("0 OF 1 COMPLETE", t.progress()); // The empty checkbox is a task, as on Windows.
        assertEquals("A FRESH PAGE", list(new Todos.Item("note", "just thoughts", false)).progress());
    }

    @Test public void loadingAppliesTheWindowsLimits() {
        List<Todos.Item> saved = new ArrayList<>();
        for (int i = 0; i < 600; i++) saved.add(new Todos.Item("unknown", "x".repeat(3000), true));
        Todos t = list(saved.toArray(new Todos.Item[0]));
        assertEquals(Todos.MAX_LINES, t.items.size());
        assertEquals("checkbox", t.items.get(0).type); // Unknown formats become checkboxes.
        assertEquals(Todos.MAX_TEXT, t.items.get(0).text.length());
        assertFalse(new Todos.Item("note", "x", true).done); // Only tasks can be done.
    }

    @Test public void progressCountsCheckboxesAndCircles() {
        Todos t = list(new Todos.Item("checkbox", "a", true), new Todos.Item("circle", "b", false), new Todos.Item("note", "c", false));
        assertEquals("1 OF 2 COMPLETE", t.progress());
        t.toggle(1);
        assertEquals("2 OF 2 COMPLETE", t.progress());
        t.toggle(2); // Not a task: nothing happens.
        assertFalse(t.items.get(2).done);
    }

    @Test public void enterSplitsAtTheCursor() {
        Todos t = list(new Todos.Item("bullet", "milk eggs", false));
        assertTrue(t.split(0, 4, 5));
        assertEquals("milk", t.items.get(0).text);
        assertEquals("eggs", t.items.get(1).text);
        assertEquals("bullet", t.items.get(1).type);
        Todos h = list(new Todos.Item("heading", "Today", false));
        h.split(0, 5, 5);
        assertEquals("checkbox", h.items.get(1).type); // A heading is followed by a checkbox.
    }

    @Test public void backspaceRemovesOnlyEmptyLinesAndKeepsOne() {
        Todos t = list(new Todos.Item("checkbox", "a", false), new Todos.Item("checkbox", "", false));
        assertFalse(t.removeIfEmpty(0));
        assertTrue(t.removeIfEmpty(1));
        Todos one = list(new Todos.Item("checkbox", "", false));
        assertFalse(one.removeIfEmpty(0));
        one.delete(0);
        assertEquals(1, one.items.size()); // The delete button also leaves a fresh line.
    }

    @Test public void numberingRestartsAfterOtherLines() {
        Todos t = list(new Todos.Item("number", "a", false), new Todos.Item("number", "b", false),
                new Todos.Item("note", "c", false), new Todos.Item("number", "d", false));
        assertEquals(1, t.numberAt(0));
        assertEquals(2, t.numberAt(1));
        assertEquals(1, t.numberAt(3));
    }

    @Test public void slashMenuOpensAtLineStartOrAfterASpace() {
        assertEquals("", Todos.menuQuery("/", 1));
        assertEquals("che", Todos.menuQuery("buy /che", 8));
        assertEquals("che", Todos.menuQuery("/CHE", 4));
        assertNull(Todos.menuQuery("a/b", 3));      // Mid-word slashes are just text.
        assertNull(Todos.menuQuery("/che x", 6));   // A space closes it.
        assertEquals(2, Todos.matching("task").size()); // Checkbox and tick circle.
        assertTrue(Todos.matching("zzz").isEmpty());
    }

    @Test public void choosingAFormatRemovesTheQuery() {
        Todos t = list(new Todos.Item("checkbox", "Plan /head", true));
        int cursor = t.choose(0, 10, "heading");
        assertEquals("Plan ", t.items.get(0).text);
        assertEquals("heading", t.items.get(0).type);
        assertFalse(t.items.get(0).done);
        assertEquals(5, cursor);
    }

    @Test public void theListCapsAt500Lines() {
        Todos t = list();
        while (t.items.size() < Todos.MAX_LINES) assertTrue(t.add(t.items.size(), "checkbox", ""));
        assertFalse(t.add(0, "checkbox", ""));
        assertFalse(t.split(0, 0, 0));
    }
}

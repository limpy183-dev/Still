package io.github.limpy183dev.still;

import android.animation.ObjectAnimator;
import android.animation.PropertyValuesHolder;
import android.animation.ValueAnimator;
import android.app.Activity;
import android.content.Intent;
import android.graphics.Insets;
import android.os.Build;
import android.text.SpannableString;
import android.text.Spanned;
import android.text.style.ForegroundColorSpan;
import android.view.View;
import android.view.WindowInsets;
import android.view.animation.DecelerateInterpolator;
import android.widget.ScrollView;
import android.widget.TextView;

/**
 * The bottom bar that stands in for the desktop sidebar, and the page heading above each page.
 * Focus space (MainActivity) is the root; another page sits on top of it, so Back always returns to Focus space.
 */
final class Nav {
    static final int FOCUS = 0, TODOS = 1, ALERTS = 2, LIMITS = 3, PROGRESS = 4;
    private static final int[] TABS = { R.id.tab_focus, R.id.tab_todos, R.id.tab_alerts, R.id.tab_limits, R.id.tab_progress };
    private static final Class<?>[] PAGES = { MainActivity.class, TodosActivity.class, AlertsActivity.class, LimitsActivity.class, HistoryActivity.class };
    /** Each page's heading on Windows: eyebrow, title, its softer second half, and the line below. */
    private static final int[][] HEADINGS = {
            { R.string.focus_eyebrow, R.string.focus_heading, R.string.focus_heading_soft, R.string.focus_subtitle },
            { R.string.todos_eyebrow, R.string.todos_heading, R.string.todos_heading_soft, R.string.todos_subtitle },
            { R.string.alerts_eyebrow, R.string.alerts_heading, R.string.alerts_heading_soft, R.string.alerts_subtitle },
            { R.string.limits_eyebrow, R.string.limits_heading, R.string.limits_heading_soft, R.string.limits_subtitle },
            { R.string.history_eyebrow, R.string.history_heading, R.string.history_heading_soft, R.string.history_subtitle },
    };
    /** Set when a tab is tapped, so Focus space (which is resumed rather than created) fades in too. */
    private static boolean arriving;

    private Nav() {}

    /** Call from onCreate after setContentView. */
    static void attach(Activity a, int page) {
        int[] h = HEADINGS[page];
        ((TextView) a.findViewById(R.id.eyebrow)).setText(h[0]);
        ((TextView) a.findViewById(R.id.heading)).setText(twoTone(a, a.getString(h[1]), a.getString(h[2])));
        ((TextView) a.findViewById(R.id.subtitle)).setText(h[3]);
        for (int i = 0; i < TABS.length; i++) {
            int to = i;
            View tab = a.findViewById(TABS[i]);
            tab.setSelected(i == page);
            tab.setOnClickListener(v -> go(a, page, to));
        }
        edgeToEdge(a);
        enter(a);
    }

    /** Call from onResume: plays the page's entrance when it was reached from the bar. */
    static void resumed(Activity a) {
        if (!arriving) return;
        arriving = false;
        enter(a);
    }

    private static void go(Activity a, int from, int to) {
        if (from == to) {
            ((ScrollView) a.findViewById(R.id.scroll)).smoothScrollTo(0, 0);
            return;
        }
        arriving = true;
        // Focus space is singleTask, so starting it closes whatever page is on top of it.
        a.startActivity(new Intent(a, PAGES[to]));
        if (from != FOCUS && to != FOCUS) a.finish();
    }

    /** "Your time. On purpose." with the second half in the softer olive, like h1 span. */
    static CharSequence twoTone(Activity a, String first, String soft) {
        SpannableString text = new SpannableString(first + " " + soft);
        text.setSpan(new ForegroundColorSpan(a.getColor(R.color.soft_ink)), first.length() + 1, text.length(), Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
        return text;
    }

    /** page-in on Windows: a short rise and fade. The active tab settles into place with it. */
    private static void enter(Activity a) {
        if (!ValueAnimator.areAnimatorsEnabled()) return; // Remove animations is on.
        View page = a.findViewById(R.id.page);
        page.setAlpha(0);
        page.setTranslationY(8 * a.getResources().getDisplayMetrics().density);
        page.animate().alpha(1).translationY(0).setDuration(420).setInterpolator(new DecelerateInterpolator(2)).start();
        for (int id : TABS) {
            View tab = a.findViewById(id);
            if (!tab.isSelected()) continue;
            tab.setScaleX(0.9f);
            tab.setScaleY(0.9f);
            tab.animate().scaleX(1).scaleY(1).setDuration(260).setInterpolator(new DecelerateInterpolator()).start();
        }
    }

    /** Draws behind the system bars; the bar sits above the gesture area and steps aside for the keyboard. */
    @SuppressWarnings("deprecation") // Android 15 and later draw edge to edge already.
    private static void edgeToEdge(Activity a) {
        if (Build.VERSION.SDK_INT < 35) a.getWindow().setDecorFitsSystemWindows(false);
        View root = a.findViewById(R.id.root), bar = a.findViewById(R.id.nav);
        int barBottom = bar.getPaddingBottom();
        root.setOnApplyWindowInsetsListener((v, insets) -> {
            Insets bars = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
            boolean typing = insets.isVisible(WindowInsets.Type.ime());
            v.setPadding(bars.left, bars.top, bars.right, typing ? insets.getInsets(WindowInsets.Type.ime()).bottom : 0);
            bar.setVisibility(typing ? View.GONE : View.VISIBLE);
            bar.setPadding(bar.getPaddingLeft(), bar.getPaddingTop(), bar.getPaddingRight(), barBottom + bars.bottom);
            return WindowInsets.CONSUMED;
        });
    }

    /** A gentle loop (the floating leaf, the breathing glow); cancel it in onPause so nothing runs off screen. */
    static ObjectAnimator loop(View view, long halfMs, PropertyValuesHolder... values) {
        ObjectAnimator loop = ObjectAnimator.ofPropertyValuesHolder(view, values);
        loop.setDuration(halfMs);
        loop.setRepeatCount(ValueAnimator.INFINITE);
        loop.setRepeatMode(ValueAnimator.REVERSE);
        loop.setInterpolator(new android.view.animation.AccelerateDecelerateInterpolator());
        if (ValueAnimator.areAnimatorsEnabled()) loop.start();
        return loop;
    }
}

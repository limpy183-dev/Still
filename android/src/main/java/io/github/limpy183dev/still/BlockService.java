package io.github.limpy183dev.still;

import android.accessibilityservice.AccessibilityService;
import android.accessibilityservice.AccessibilityServiceInfo;
import android.content.Intent;
import android.graphics.PixelFormat;
import android.graphics.Rect;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.view.Gravity;
import android.view.View;
import android.view.WindowManager;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityNodeInfo;
import android.view.accessibility.AccessibilityWindowInfo;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

import java.util.ArrayDeque;
import java.util.Collections;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;

/**
 * Blocks the session's apps. Android has no AppLocker, so this watches which app windows are on screen
 * and sends a blocked app to the background, covering it until it is gone.
 *
 * Resource use: with no session the service asks for no events at all, so it is idle. During a session
 * it only receives window changes (not content changes), coalesced and checked once each.
 *
 * Safety: any error removes the cover (fail open). Protected apps (home screen, phone, Settings, keyboards)
 * are never blocked. The cover only covers blocked windows and always has a Go home button.
 */
public final class BlockService extends AccessibilityService {
    private static final long SETTLE_MS = 80, GUARD_RECHECK_MS = 1000, TOAST_GAP_MS = 3000;
    private static final int MAX_NODES = 400;
    private static BlockService instance;

    private final Handler handler = new Handler(Looper.getMainLooper());
    private final Runnable check = this::check;
    private Set<String> blocked = Collections.emptySet(), guard = Collections.emptySet();
    private String sessionId;
    private Boolean listening;
    private LinearLayout cover;
    private TextView coverText;
    private final Rect coverBounds = new Rect();
    private long lastToast;

    /** Re-evaluates the screen after the session changed. Posted, so it never runs re-entrantly. */
    static void refresh() {
        BlockService service = instance;
        if (service == null) return;
        service.handler.removeCallbacks(service.check);
        service.handler.post(service.check);
    }

    @Override
    protected void onServiceConnected() {
        instance = this;
        // Runs after every boot too: restores the end alarm and notification, and re-reads the clocks.
        Store.reanchor(this);
        refresh();
    }

    @Override
    public void onAccessibilityEvent(AccessibilityEvent event) {
        handler.removeCallbacks(check);
        handler.postDelayed(check, SETTLE_MS);
    }

    @Override
    public void onInterrupt() { }

    @Override
    public boolean onUnbind(Intent intent) {
        stop();
        return false;
    }

    @Override
    public void onDestroy() {
        stop();
        super.onDestroy();
    }

    private void stop() {
        if (instance == this) instance = null;
        handler.removeCallbacksAndMessages(null);
        hideCover();
    }

    private void check() {
        try {
            enforce();
        } catch (RuntimeException e) {
            hideCover(); // Fail open: an error must never leave a cover stuck on screen.
        }
    }

    private void enforce() {
        handler.removeCallbacks(check);
        Session s = Store.current(this);
        listen(s != null);
        if (s == null) {
            sessionId = null;
            hideCover();
            return;
        }
        if (!s.id.equals(sessionId)) {
            sessionId = s.id;
            guard = Device.guardPackages(this);
            blocked = new HashSet<>(s.apps.keySet());
            blocked.removeAll(Device.protectedPackages(this));
        }
        Rect area = null;
        String what = null; // Null means one of Still's own settings screens.
        boolean sendHome = false, guardOpen = false;
        for (AccessibilityWindowInfo window : getWindows()) {
            if (window.getType() != AccessibilityWindowInfo.TYPE_APPLICATION) continue;
            AccessibilityNodeInfo root = window.getRoot();
            if (root == null || root.getPackageName() == null) continue;
            String pkg = root.getPackageName().toString();
            boolean hit = blocked.contains(pkg);
            if (!hit && s.strict && guard.contains(pkg)) {
                // Settings or the uninstaller showing Still: the screens that could switch it off or remove it.
                guardOpen = true;
                hit = mentionsStill(root);
            }
            if (!hit) continue;
            Rect bounds = new Rect();
            window.getBoundsInScreen(bounds);
            if (area == null) area = bounds; else area.union(bounds);
            if (s.apps.containsKey(pkg)) what = s.apps.get(pkg);
            // Home does not close picture-in-picture; that window just stays covered.
            if (!window.isInPictureInPictureMode()) sendHome = true;
        }
        if (area == null) {
            hideCover();
            // Settings content loads after its window appears, so look again while it stays open.
            if (guardOpen) handler.postDelayed(check, GUARD_RECHECK_MS);
            return;
        }
        Session.Clock now = Store.clock(this);
        String until = Store.time(this, now.wall + s.remaining(now));
        String message = what == null ? getString(R.string.cover_guard, until) : getString(R.string.cover_text, what, until);
        showCover(area, message);
        if (sendHome) {
            performGlobalAction(GLOBAL_ACTION_HOME);
            long t = SystemClock.elapsedRealtime();
            if (t - lastToast > TOAST_GAP_MS) {
                lastToast = t;
                Toast.makeText(this, message, Toast.LENGTH_SHORT).show();
            }
        }
    }

    private boolean mentionsStill(AccessibilityNodeInfo root) {
        String name = getString(R.string.app_name);
        if (!root.findAccessibilityNodeInfosByText(name).isEmpty()) return true;
        // Compose screens (newer Settings pages) don't answer text search, so walk the tree, bounded.
        String needle = name.toLowerCase(Locale.ROOT);
        ArrayDeque<AccessibilityNodeInfo> queue = new ArrayDeque<>();
        queue.add(root);
        for (int seen = 0; !queue.isEmpty() && seen < MAX_NODES; seen++) {
            AccessibilityNodeInfo node = queue.poll();
            if (contains(node.getText(), needle) || contains(node.getContentDescription(), needle)) return true;
            for (int i = 0; i < node.getChildCount(); i++) {
                AccessibilityNodeInfo child = node.getChild(i);
                if (child != null) queue.add(child);
            }
        }
        return false;
    }

    private static boolean contains(CharSequence text, String needle) {
        return text != null && text.toString().toLowerCase(Locale.ROOT).contains(needle);
    }

    /** Asks for window changes only while a session runs; otherwise no events are delivered at all. */
    private void listen(boolean on) {
        if (listening != null && listening == on) return;
        AccessibilityServiceInfo info = getServiceInfo();
        if (info == null) return;
        info.eventTypes = on ? AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED | AccessibilityEvent.TYPE_WINDOWS_CHANGED : 0;
        setServiceInfo(info);
        listening = on;
    }

    private void showCover(Rect bounds, String text) {
        WindowManager windows = getSystemService(WindowManager.class);
        boolean moved = !bounds.equals(coverBounds);
        coverBounds.set(bounds);
        if (cover == null) {
            cover = new LinearLayout(this);
            cover.setOrientation(LinearLayout.VERTICAL);
            cover.setGravity(Gravity.CENTER);
            cover.setBackgroundColor(getColor(R.color.cover_bg));
            int pad = Math.round(24 * getResources().getDisplayMetrics().density);
            cover.setPadding(pad, pad, pad, pad);
            TextView title = new TextView(this);
            title.setText(R.string.cover_title);
            title.setTextColor(getColor(R.color.lime));
            title.setTextSize(22);
            title.setGravity(Gravity.CENTER);
            coverText = new TextView(this);
            coverText.setTextColor(getColor(R.color.cover_text));
            coverText.setTextSize(16);
            coverText.setGravity(Gravity.CENTER);
            coverText.setPadding(0, pad / 2, 0, pad);
            Button home = new Button(this);
            home.setText(R.string.go_home);
            home.setOnClickListener(v -> performGlobalAction(GLOBAL_ACTION_HOME));
            cover.addView(title);
            cover.addView(coverText);
            cover.addView(home);
            windows.addView(cover, layout(bounds));
        } else if (moved) {
            windows.updateViewLayout(cover, layout(bounds));
        }
        coverText.setText(text);
    }

    private static WindowManager.LayoutParams layout(Rect bounds) {
        WindowManager.LayoutParams params = new WindowManager.LayoutParams(bounds.width(), bounds.height(),
                WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY,
                WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE | WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN
                        | WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
                PixelFormat.OPAQUE);
        params.gravity = Gravity.TOP | Gravity.START;
        params.x = bounds.left;
        params.y = bounds.top;
        params.layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_ALWAYS;
        return params;
    }

    private void hideCover() {
        if (cover == null) return;
        try {
            getSystemService(WindowManager.class).removeView(cover);
        } catch (RuntimeException ignored) { }
        cover = null;
        coverText = null;
        coverBounds.setEmpty();
    }
}

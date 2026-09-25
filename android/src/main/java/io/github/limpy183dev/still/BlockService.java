package io.github.limpy183dev.still;

import android.accessibilityservice.AccessibilityService;
import android.accessibilityservice.AccessibilityServiceInfo;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.graphics.PixelFormat;
import android.graphics.Rect;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;
import android.os.SystemClock;
import android.view.Gravity;
import android.view.View;
import android.view.WindowManager;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityNodeInfo;
import android.view.accessibility.AccessibilityWindowInfo;
import android.widget.TextView;

import java.io.File;
import java.time.LocalTime;
import java.util.ArrayDeque;
import java.util.Collections;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;

/**
 * Blocks the session's apps. Android has no AppLocker, so this watches which app windows are on screen
 * and sends a blocked app to the background, covering it until it is gone.
 *
 * Websites: the address bar of supported browsers (Device.ADDRESS_BARS) is read, and a blocked site is
 * stepped back from and covered. Other browsers are in the session's app list, so they are blocked outright.
 *
 * Daily limits and bedtime (Limits) work the same way outside sessions. Time counts only while a limited
 * site is the page in the active browser window with the screen on.
 *
 * Resource use: with no session and no limits the service asks for no events at all, so it is idle.
 * Otherwise it only receives window changes (not content changes), coalesced and checked once each. It
 * polls only while a supported browser or a strict session's Settings screen is on screen, never with
 * the screen off.
 *
 * Safety: any error removes the cover (fail open). Protected apps (home screen, phone, Settings, keyboards)
 * are never blocked. The cover only covers blocked windows and always has a Go home button.
 */
public final class BlockService extends AccessibilityService {
    private static final long SETTLE_MS = 80, RECHECK_MS = 700, LIMIT_RECHECK_MS = 1000, MAX_COUNT_STEP_MS = 2000,
            BACK_GAP_MS = 1500, ALARM_RETURN_MS = 300;
    private static final int MAX_NODES = 400;
    private static BlockService instance;

    private final Handler handler = new Handler(Looper.getMainLooper());
    private final Runnable check = this::check;
    private Set<String> blocked = Collections.emptySet(), guard = Collections.emptySet();
    private String sessionId;
    private Boolean listening;
    private TextView cover;
    private View screenView;
    private String screenKey;
    private final Rect coverBounds = new Rect();
    private long lastBack;
    private String countingDomain;
    private long countedAt;
    private PowerManager power;
    /** Screen on/off: polling and time counting stop while the screen is off. */
    private final BroadcastReceiver screen = new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) { refresh(); }
    };

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
        power = getSystemService(PowerManager.class);
        IntentFilter filter = new IntentFilter(Intent.ACTION_SCREEN_ON);
        filter.addAction(Intent.ACTION_SCREEN_OFF);
        registerReceiver(screen, filter);
        // Runs after every boot too: restores the end alarm and notification, and re-reads the clocks.
        Store.reanchor(this);
        AlertStore.tick(this); // An alert waiting for blocking to be switched on can start now.
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
        try { unregisterReceiver(screen); } catch (IllegalArgumentException notRegistered) { }
        stopCounting();
        hideCover();
        hideScreen();
    }

    private void check() {
        try {
            enforce();
        } catch (RuntimeException e) {
            hideCover(); // Fail open: an error must never leave a cover stuck on screen.
            hideScreen();
        }
    }

    private void enforce() {
        handler.removeCallbacks(check);
        Session s = Store.current(this);
        Limits limits = LimitStore.limits(this);
        boolean limited = limits.active();
        listen(s != null || limited);
        if (s == null) {
            sessionId = null;
        } else if (!s.id.equals(sessionId)) {
            sessionId = s.id;
            guard = Device.guardPackages(this);
            blocked = new HashSet<>(s.apps.keySet());
            blocked.removeAll(Device.protectedPackages(this));
        }
        if ((s == null && !limited) || !power.isInteractive()) {
            // Nothing to enforce, or the screen is off: stop counting and polling until something changes.
            stopCounting();
            hideCover();
            hideScreen();
            return;
        }
        LocalTime clock = LocalTime.now();
        int minute = clock.getHour() * 60 + clock.getMinute();
        Rect pip = null;
        String pipText = null, counting = null, redirectTo = null, redirectIn = null;
        Shown shown = null;
        boolean sendHome = false, sendBack = false, poll = false;
        for (AccessibilityWindowInfo window : getWindows()) {
            if (window.getType() != AccessibilityWindowInfo.TYPE_APPLICATION) continue;
            AccessibilityNodeInfo root = window.getRoot();
            if (root == null || root.getPackageName() == null) continue;
            String pkg = root.getPackageName().toString();
            Shown hit = null;
            boolean site = false;
            if (s != null && blocked.contains(pkg))
                hit = session(s, getString(R.string.cover_text, s.apps.containsKey(pkg) ? s.apps.get(pkg) : pkg, until(s)));
            String bar = Device.ADDRESS_BARS.get(pkg);
            if (hit == null && bar != null && (limited || !s.websites.isEmpty())) {
                // The address bar changes without a window event, so keep looking while a browser is open.
                poll = true;
                String host = Websites.hostOf(addressBar(root, bar));
                String domain = s == null ? null : Websites.blockedBy(host, s.websites);
                Limits.Site limit = domain == null && limited ? limits.find(host) : null;
                String reason = limit == null ? null : limits.blocked(limit, LimitStore.secondsUsed(this, limit.domain), minute);
                if (domain != null) {
                    site = true;
                    hit = session(s, getString(R.string.cover_text, domain, until(s)));
                    if (BlockScreen.REDIRECT.equals(s.screen.mode)) { redirectTo = s.screen.redirect; redirectIn = pkg; }
                } else if (reason != null) {
                    site = true;
                    hit = Limits.BEDTIME.equals(reason) ? limitScreen(BlockScreen.DUSK, R.string.bedtime_title,
                            getString(R.string.bedtime_text, limit.domain, Store.clockText(this, limits.to)))
                            : limitScreen(BlockScreen.GARDEN, R.string.limit_title,
                            getResources().getQuantityString(R.plurals.limit_text, limit.minutes, limit.minutes, limit.domain));
                } else if (limit != null && limit.minutes > 0 && window.isActive()) {
                    counting = limit.domain; // Time counts only for the page in the window being used.
                }
            }
            if (hit == null && s != null && s.strict && guard.contains(pkg)) {
                // Settings or the uninstaller showing Still: the screens that could switch it off or remove it.
                // Their content loads after the window appears, so keep looking while one is open.
                poll = true;
                if (mentionsStill(root)) hit = session(s, getString(R.string.cover_guard, until(s)));
            }
            if (hit == null) continue;
            if (window.isInPictureInPictureMode()) {
                // Home and Back do not close picture-in-picture, so that window is covered where it is.
                Rect bounds = new Rect();
                window.getBoundsInScreen(bounds);
                if (pip == null) pip = bounds; else pip.union(bounds);
                pipText = hit.status;
                continue;
            }
            shown = hit;
            if (site) sendBack = true; else sendHome = true;
        }
        long t = SystemClock.elapsedRealtime();
        countTime(counting, t);
        if (poll) handler.postDelayed(check, s != null ? RECHECK_MS : LIMIT_RECHECK_MS);
        if (pip != null) showCover(pip, pipText); else hideCover();
        if (sendHome) {
            performGlobalAction(GLOBAL_ACTION_HOME);
            Intent alarm = AlarmActivity.ringing;
            if (alarm != null) {
                // Home also sends away an alarm that just opened over the blocked app, so bring it back.
                // The alarm explains what happened, so no block screen goes over it.
                handler.postDelayed(() -> {
                    try { startActivity(alarm); } catch (RuntimeException ignored) { }
                }, ALARM_RETURN_MS);
                shown = null;
            }
        } else if (sendBack && t - lastBack > BACK_GAP_MS) {
            // A blocked website steps back a page, leaving the browser usable for everything else.
            lastBack = t;
            performGlobalAction(GLOBAL_ACTION_BACK);
            if (redirectTo != null && !sendHome) {
                openRedirect(redirectTo, redirectIn);
                return; // Like Windows, a redirect screen shows the destination instead of a block screen.
            }
        }
        // Stays up until closed, so it's clear why the app or page went away. It never has the blocked
        // app or page behind it: Home or Back has already been pressed.
        if (shown != null && redirectTo == null) showScreen(shown);
    }

    /** What a full block screen says. */
    private static final class Shown {
        final String style, title, text, status, footnote;
        final File image;
        Shown(String style, String title, String text, String status, String footnote, File image) {
            this.style = style; this.title = title; this.text = text; this.status = status; this.footnote = footnote; this.image = image;
        }
        String key() { return style + title + text + status; }
    }

    private Shown session(Session s, String status) {
        BlockScreen screen = s.screen;
        return new Shown(screen.style(), screen.headline(), screen.body(), status, getString(R.string.screen_footnote),
                screen.image ? new File(getFilesDir(), Store.SESSION_IMAGE) : null);
    }

    /** Limits and bedtime use the Windows limit page's wording and looks. */
    private Shown limitScreen(String style, int title, String text) {
        return new Shown(style, getString(title), text, getString(R.string.limit_status), null, null);
    }

    private void openRedirect(String url, String browser) {
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)).setPackage(browser).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        } catch (RuntimeException unavailable) { } // Back has already left the blocked page.
    }

    private String until(Session s) {
        Session.Clock now = Store.clock(this);
        return Store.time(this, now.wall + s.remaining(now));
    }

    /** Adds the time since the last check while the same limited site stays open. Gaps are capped. */
    private void countTime(String domain, long now) {
        if (domain != null && domain.equals(countingDomain))
            LimitStore.count(this, domain, Math.min(now - countedAt, MAX_COUNT_STEP_MS));
        else if (countingDomain != null) LimitStore.flush(this);
        countingDomain = domain;
        countedAt = now;
    }

    private void stopCounting() {
        if (countingDomain != null) LimitStore.flush(this);
        countingDomain = null;
    }

    /** The page address shown in a browser's bar, or null while the user is typing in it. */
    private static String addressBar(AccessibilityNodeInfo root, String viewId) {
        for (AccessibilityNodeInfo node : root.findAccessibilityNodeInfosByViewId(viewId)) {
            if (!node.isFocused() && node.getText() != null) return node.getText().toString();
        }
        return null;
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

    /** Asks for window changes only while a session runs or limits are set; otherwise no events at all. */
    private void listen(boolean on) {
        if (listening != null && listening == on) return;
        AccessibilityServiceInfo info = getServiceInfo();
        if (info == null) return;
        info.eventTypes = on ? AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED | AccessibilityEvent.TYPE_WINDOWS_CHANGED : 0;
        setServiceInfo(info);
        listening = on;
    }

    /** A plain cover over picture-in-picture windows, which Home and Back cannot close. */
    private void showCover(Rect bounds, String text) {
        WindowManager windows = getSystemService(WindowManager.class);
        boolean moved = !bounds.equals(coverBounds);
        coverBounds.set(bounds);
        if (cover == null) {
            cover = new TextView(this);
            cover.setGravity(Gravity.CENTER);
            cover.setBackgroundColor(getColor(R.color.cover_bg));
            cover.setTextColor(getColor(R.color.cover_text));
            int pad = Math.round(8 * getResources().getDisplayMetrics().density);
            cover.setPadding(pad, pad, pad, pad);
            windows.addView(cover, layout(bounds));
        } else if (moved) {
            windows.updateViewLayout(cover, layout(bounds));
        }
        cover.setText(text);
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
        coverBounds.setEmpty();
    }

    /** The full block screen. Close always dismisses it; it is rebuilt only when its words change. */
    private void showScreen(Shown content) {
        if (screenView != null && content.key().equals(screenKey)) return;
        hideScreen();
        screenKey = content.key();
        screenView = BlockScreenView.build(this, content.style, content.image, content.title, content.text, content.status,
                content.footnote, getString(R.string.close), v -> { hideScreen(); refresh(); });
        WindowManager.LayoutParams params = new WindowManager.LayoutParams(WindowManager.LayoutParams.MATCH_PARENT,
                WindowManager.LayoutParams.MATCH_PARENT, WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY,
                WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE | WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN,
                PixelFormat.OPAQUE);
        params.layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_ALWAYS;
        getSystemService(WindowManager.class).addView(screenView, params);
    }

    private void hideScreen() {
        if (screenView == null) return;
        try {
            getSystemService(WindowManager.class).removeView(screenView);
        } catch (RuntimeException ignored) { }
        screenView = null; // Drops the view and any image with it.
        screenKey = null;
    }
}

package io.github.limpy183dev.still;

import android.app.admin.DevicePolicyManager;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.net.Uri;
import android.os.UserManager;
import android.provider.Settings;
import android.telecom.TelecomManager;
import android.view.inputmethod.InputMethodInfo;
import android.view.inputmethod.InputMethodManager;

import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/** Device checks that keep Still safe, mirroring the protected-component and managed-PC rules on Windows. */
final class Device {
    private Device() {}

    /**
     * Apps that are never blocked, whatever is stored: Still, the home screen, Settings, the phone and
     * emergency apps, keyboards, the package installer and the system UI. Checked again when blocking.
     */
    static Set<String> protectedPackages(Context c) {
        Set<String> out = guardPackages(c);
        PackageManager pm = c.getPackageManager();
        out.add(c.getPackageName());
        out.add("android");
        out.add("com.android.systemui");
        out.add("com.android.phone");
        out.add("com.android.server.telecom");
        out.add("com.android.emergency");
        addHandlers(out, pm, new Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_HOME));
        addHandlers(out, pm, new Intent(Intent.ACTION_DIAL));
        TelecomManager telecom = c.getSystemService(TelecomManager.class);
        if (telecom != null && telecom.getDefaultDialerPackage() != null) out.add(telecom.getDefaultDialerPackage());
        InputMethodManager keyboards = c.getSystemService(InputMethodManager.class);
        if (keyboards != null) for (InputMethodInfo info : keyboards.getEnabledInputMethodList()) out.add(info.getPackageName());
        return out;
    }

    /** Screens that can switch Still off or remove it. A strict session covers them when they show Still. */
    static Set<String> guardPackages(Context c) {
        Set<String> out = new HashSet<>();
        PackageManager pm = c.getPackageManager();
        Uri self = Uri.fromParts("package", c.getPackageName(), null);
        out.add("com.android.settings");
        addHandlers(out, pm, new Intent(Settings.ACTION_SETTINGS));
        addHandlers(out, pm, new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS));
        addHandlers(out, pm, new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, self));
        addHandlers(out, pm, new Intent(Intent.ACTION_DELETE, self));
        return out;
    }

    private static void addHandlers(Set<String> out, PackageManager pm, Intent intent) {
        List<ResolveInfo> handlers = pm.queryIntentActivities(intent, PackageManager.MATCH_ALL);
        for (ResolveInfo info : handlers) out.add(info.activityInfo.packageName);
    }

    /**
     * Still refuses to run on work profiles and organisation-managed phones, like it refuses domain and
     * MDM-managed PCs, so it never interferes with an organisation's device policy. Returns null if allowed.
     */
    static String managedReason(Context c) {
        UserManager users = c.getSystemService(UserManager.class);
        if (users != null && users.isManagedProfile()) return c.getString(R.string.managed_profile);
        DevicePolicyManager policy = c.getSystemService(DevicePolicyManager.class);
        if (policy == null) return null;
        if (policy.isOrganizationOwnedDeviceWithManagedProfile()) return c.getString(R.string.managed_device);
        List<ComponentName> admins = policy.getActiveAdmins();
        if (admins != null) for (ComponentName admin : admins) {
            String pkg = admin.getPackageName();
            if (policy.isDeviceOwnerApp(pkg) || policy.isProfileOwnerApp(pkg)) return c.getString(R.string.managed_device);
        }
        return null;
    }

    /**
     * Browsers whose address bar Still can read, with that bar's view id. Custom tabs opened from other
     * apps run in these packages too. Other browsers are blocked outright during website sessions.
     */
    static final Map<String, String> ADDRESS_BARS = new HashMap<>();
    static {
        for (String chromium : new String[] { "com.android.chrome", "com.chrome.beta", "com.chrome.dev", "com.chrome.canary",
                "com.microsoft.emmx", "com.brave.browser", "com.vivaldi.browser", "org.chromium.chrome" })
            ADDRESS_BARS.put(chromium, chromium + ":id/url_bar");
        ADDRESS_BARS.put("org.mozilla.firefox", "org.mozilla.firefox:id/mozac_browser_toolbar_url_view");
        ADDRESS_BARS.put("org.mozilla.firefox_beta", "org.mozilla.firefox_beta:id/mozac_browser_toolbar_url_view");
        ADDRESS_BARS.put("com.sec.android.app.sbrowser", "com.sec.android.app.sbrowser:id/location_bar_edit_text");
        ADDRESS_BARS.put("com.duckduckgo.mobile.android", "com.duckduckgo.mobile.android:id/omnibarTextInput");
    }

    /** Installed apps that open any web link (browsers) but whose address bar Still can't read. */
    static Map<String, String> otherBrowsers(Context c) {
        PackageManager pm = c.getPackageManager();
        Set<String> skip = protectedPackages(c);
        Map<String, String> out = new LinkedHashMap<>();
        Intent web = new Intent(Intent.ACTION_VIEW, Uri.parse("https://example.com/")).addCategory(Intent.CATEGORY_BROWSABLE);
        for (ResolveInfo info : pm.queryIntentActivities(web, PackageManager.MATCH_ALL)) {
            String pkg = info.activityInfo.packageName;
            if (!ADDRESS_BARS.containsKey(pkg) && !skip.contains(pkg)) out.put(pkg, String.valueOf(info.loadLabel(pm)));
        }
        return out;
    }

    /** Whether the user has switched on Still's accessibility service. */
    static boolean blockingEnabled(Context c) {
        String enabled = Settings.Secure.getString(c.getContentResolver(), Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES);
        if (enabled == null) return false;
        ComponentName self = new ComponentName(c, BlockService.class);
        for (String service : enabled.split(":")) if (self.equals(ComponentName.unflattenFromString(service))) return true;
        return false;
    }
}

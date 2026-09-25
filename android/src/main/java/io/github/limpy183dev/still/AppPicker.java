package io.github.limpy183dev.still;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.graphics.drawable.Drawable;
import android.view.View;
import android.view.ViewGroup;
import android.widget.ArrayAdapter;
import android.widget.ListView;
import android.widget.TextView;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/** Launchable apps (protected ones left out), listed once off the main thread, and the picker dialog. */
final class AppPicker {
    private static final class App {
        final String pkg, label;
        final ResolveInfo info;
        Drawable icon;
        App(String pkg, String label, ResolveInfo info) { this.pkg = pkg; this.label = label; this.info = info; }
    }

    private final Activity activity;
    private final ArrayAdapter<App> apps;
    boolean loading;

    AppPicker(Activity activity) {
        this.activity = activity;
        apps = new ArrayAdapter<App>(activity, android.R.layout.simple_list_item_multiple_choice) {
            @Override
            public View getView(int position, View convert, ViewGroup parent) {
                TextView row = (TextView) super.getView(position, convert, parent);
                App app = getItem(position);
                row.setText(app.label);
                float dp = activity.getResources().getDisplayMetrics().density;
                if (app.icon == null) {
                    app.icon = app.info.loadIcon(activity.getPackageManager());
                    int size = Math.round(36 * dp);
                    app.icon.setBounds(0, 0, size, size);
                }
                row.setCompoundDrawablesRelative(app.icon, null, null, null);
                row.setCompoundDrawablePadding(Math.round(16 * dp));
                return row;
            }
        };
    }

    boolean loaded() { return !apps.isEmpty(); }

    /** Lists apps once, then keeps only still-installed ones in {@code selected} and calls {@code done}. */
    void load(Set<String> selected, Runnable done) {
        if (loading || loaded()) return;
        loading = true;
        new Thread(() -> {
            PackageManager pm = activity.getPackageManager();
            Set<String> skip = Device.protectedPackages(activity);
            Map<String, App> found = new LinkedHashMap<>();
            Intent launcher = new Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER);
            for (ResolveInfo info : pm.queryIntentActivities(launcher, 0)) {
                String pkg = info.activityInfo.packageName;
                if (!skip.contains(pkg) && !found.containsKey(pkg)) found.put(pkg, new App(pkg, String.valueOf(info.loadLabel(pm)), info));
            }
            List<App> sorted = new ArrayList<>(found.values());
            sorted.sort((a, b) -> a.label.compareToIgnoreCase(b.label));
            activity.runOnUiThread(() -> {
                if (activity.isDestroyed()) return;
                loading = false;
                apps.addAll(sorted);
                selected.retainAll(found.keySet());
                done.run();
            });
        }).start();
    }

    /** The chosen apps' labels by package, in list order. */
    Map<String, String> chosen(Set<String> selected) {
        Map<String, String> out = new LinkedHashMap<>();
        for (int i = 0; i < apps.getCount(); i++) if (selected.contains(apps.getItem(i).pkg)) out.put(apps.getItem(i).pkg, apps.getItem(i).label);
        return out;
    }

    /** The picker is a dialog so the list only exists (and loads icons) while it is open. */
    void choose(Set<String> selected, Runnable changed) {
        if (loading) return;
        ListView list = new ListView(activity);
        list.setChoiceMode(ListView.CHOICE_MODE_MULTIPLE);
        list.setAdapter(apps);
        for (int i = 0; i < apps.getCount(); i++) list.setItemChecked(i, selected.contains(apps.getItem(i).pkg));
        list.setOnItemClickListener((parent, view, position, id) -> {
            App app = apps.getItem(position);
            if (list.isItemChecked(position)) selected.add(app.pkg); else selected.remove(app.pkg);
            changed.run();
        });
        new AlertDialog.Builder(activity).setTitle(R.string.apps_title).setView(list)
                .setPositiveButton(R.string.done, null)
                .setOnDismissListener(d -> { for (int i = 0; i < apps.getCount(); i++) apps.getItem(i).icon = null; })
                .show();
    }
}

package io.github.limpy183dev.still;

import android.animation.ValueAnimator;
import android.app.Activity;
import android.content.Context;
import android.content.SharedPreferences;
import android.content.res.Configuration;
import android.graphics.Color;
import android.graphics.drawable.Drawable;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.LayerDrawable;
import android.os.Bundle;
import android.view.View;
import android.view.ViewGroup;

/**
 * Every Still screen, alarm screens included, follows the accessibility options in Settings (as app/accessibility.js):
 * text size, high contrast, an easier-to-read font, stronger focus outlines and a gentler pace.
 * Changing an option recreates open screens when they are next shown.
 */
public abstract class StillActivity extends Activity {
    static final String TEXT_SIZE = "textSize", HIGH_CONTRAST = "highContrast", READABLE_FONT = "readableFont",
            STRONG_FOCUS = "strongFocus", REDUCED_MOTION = "reducedMotion";
    static final int[] TEXT_SIZES = { 100, 115, 130, 150, 175 };
    /**
     * High contrast swaps the palette through resources in values-mcc999(-night): colors are plain @color
     * references in drawables, styles and code, and a resource qualifier is the only switch that reaches all of them.
     * MCC 999 is reserved for private networks, never a public carrier, and only Still's own screens see the override.
     */
    private static final int HIGH_CONTRAST_MCC = 999;
    /** Bumped when an option changes, so screens behind Settings recreate themselves on return. */
    static int generation;
    private int shownGeneration;
    private View outlined;
    private Drawable outline;

    static SharedPreferences settings(Context c) { return c.getSharedPreferences("prefs", MODE_PRIVATE); }

    static int textSize(Context c) {
        int size = settings(c).getInt(TEXT_SIZE, 100);
        for (int allowed : TEXT_SIZES) if (allowed == size) return size;
        return 100;
    }

    /** Animations run unless Android's Remove animations or Still's own gentler pace is on. */
    static boolean motion(Context c) {
        return ValueAnimator.areAnimatorsEnabled() && !settings(c).getBoolean(REDUCED_MOTION, false);
    }

    @Override
    protected void attachBaseContext(Context base) {
        super.attachBaseContext(base);
        int size = textSize(base);
        boolean contrast = settings(base).getBoolean(HIGH_CONTRAST, false);
        if (size == 100 && !contrast) return;
        // Only the fields set here are overridden; everything else follows the phone. Text size multiplies the
        // phone's own font size, like page zoom on Windows multiplies the Windows scale.
        Configuration override = new Configuration();
        override.fontScale = base.getResources().getConfiguration().fontScale * size / 100f;
        if (contrast) override.mcc = HIGH_CONTRAST_MCC;
        applyOverrideConfiguration(override);
    }

    @Override
    protected void onCreate(Bundle state) {
        shownGeneration = generation;
        if (settings(this).getBoolean(READABLE_FONT, false)) getTheme().applyStyle(R.style.ReadableFont, true);
        super.onCreate(state);
    }

    @Override
    public void onContentChanged() {
        super.onContentChanged();
        if (!motion(this)) stillButtons(getWindow().getDecorView());
    }

    /** The 1-pixel press on buttons is an animation too. */
    private static void stillButtons(View v) {
        v.setStateListAnimator(null);
        if (v instanceof ViewGroup) for (int i = 0; i < ((ViewGroup) v).getChildCount(); i++) stillButtons(((ViewGroup) v).getChildAt(i));
    }

    @Override
    protected void onPostCreate(Bundle state) {
        super.onPostCreate(state);
        if (!settings(this).getBoolean(STRONG_FOCUS, false)) return;
        float dp = getResources().getDisplayMetrics().density;
        // A thick black ring with a white line inside, like body.strong-focus :focus-visible, so it shows on any color.
        GradientDrawable black = new GradientDrawable(), white = new GradientDrawable();
        black.setStroke(Math.round(3 * dp), Color.BLACK);
        black.setCornerRadius(6 * dp);
        white.setStroke(Math.round(2 * dp), Color.WHITE);
        white.setCornerRadius(4 * dp);
        LayerDrawable ring = new LayerDrawable(new Drawable[] { black, white });
        int inset = Math.round(3 * dp);
        ring.setLayerInset(1, inset, inset, inset, inset);
        outline = ring;
        View decor = getWindow().getDecorView();
        decor.getViewTreeObserver().addOnGlobalFocusChangeListener((before, now) -> outline(now));
        decor.getViewTreeObserver().addOnTouchModeChangeListener(touch -> outline(getCurrentFocus()));
    }

    /**
     * Outlines what the keyboard (or a switch or D-pad) reached; touching the screen removes it, as :focus-visible does.
     * ponytail: sized when focus arrives; a focused view that grows keeps the old outline until focus moves.
     */
    private void outline(View view) {
        if (outlined != null) outlined.getOverlay().remove(outline);
        outlined = view == null || view.isInTouchMode() ? null : view;
        if (outlined == null) return;
        outline.setBounds(0, 0, view.getWidth(), view.getHeight());
        view.getOverlay().add(outline);
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (shownGeneration != generation) recreate();
    }
}

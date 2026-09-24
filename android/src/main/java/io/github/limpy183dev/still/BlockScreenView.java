package io.github.limpy183dev.still;

import android.content.Context;
import android.content.res.ColorStateList;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Outline;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.ViewOutlineProvider;
import android.widget.Button;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import java.io.File;

/**
 * Draws a block screen in one of the Windows block page's looks (app/browser-extension/blocked.css):
 * Quiet garden, Evening calm, A clean page, or a custom screen with the user's own image.
 */
final class BlockScreenView {
    private BlockScreenView() {}

    static int background(String style) {
        switch (style) {
            case BlockScreen.DUSK: return 0xFF192830;
            case BlockScreen.PAPER: return 0xFFF6F1E7;
            case BlockScreen.CUSTOM: return 0xFFEFF1ED;
            default: return 0xFFEEF1E7;
        }
    }

    static int foreground(String style) {
        switch (style) {
            case BlockScreen.DUSK: return 0xFFE7D9BD;
            case BlockScreen.PAPER: return 0xFF36312A;
            case BlockScreen.CUSTOM: return 0xFF27392E;
            default: return 0xFF283E32;
        }
    }

    /**
     * @param image  a custom image file, or null
     * @param button the dismiss button's label, or null for none (the preview)
     */
    static View build(Context c, String style, File image, String title, String text, String status,
                      String footnote, String button, View.OnClickListener onButton) {
        float dp = c.getResources().getDisplayMetrics().density;
        int fg = foreground(style);

        LinearLayout column = new LinearLayout(c);
        column.setOrientation(LinearLayout.VERTICAL);
        column.setGravity(Gravity.CENTER_HORIZONTAL);
        int pad = Math.round(28 * dp);
        column.setPadding(pad, Math.round(56 * dp), pad, Math.round(40 * dp));

        TextView brand = text(c, "still.", 28, fg, Typeface.create(Typeface.SERIF, Typeface.ITALIC));
        column.addView(brand);

        ImageView orbit = new ImageView(c);
        orbit.setImageResource(BlockScreen.PAPER.equals(style) ? R.drawable.orbit_square : R.drawable.orbit);
        orbit.setImageTintList(ColorStateList.valueOf(fg));
        orbit.setAlpha(0.7f);
        LinearLayout.LayoutParams orbitSize = new LinearLayout.LayoutParams(Math.round(92 * dp), Math.round(92 * dp));
        orbitSize.topMargin = Math.round(36 * dp);
        column.addView(orbit, orbitSize);

        TextView eyebrow = text(c, c.getString(R.string.screen_eyebrow), 11, fg, Typeface.SANS_SERIF);
        eyebrow.setLetterSpacing(0.27f);
        spaced(column, eyebrow, 28, dp);

        Bitmap picture = image == null ? null : decode(image, c.getResources().getDisplayMetrics().widthPixels);
        if (picture != null) {
            ImageView view = new ImageView(c);
            view.setImageBitmap(picture);
            view.setAdjustViewBounds(true);
            view.setMaxHeight(Math.round(280 * dp));
            view.setScaleType(ImageView.ScaleType.FIT_CENTER);
            float radius = 20 * dp;
            view.setOutlineProvider(new ViewOutlineProvider() {
                @Override
                public void getOutline(View v, Outline outline) { outline.setRoundRect(0, 0, v.getWidth(), v.getHeight(), radius); }
            });
            view.setClipToOutline(true);
            spaced(column, view, 4, dp);
        }

        TextView headline = text(c, title, 34, fg, Typeface.SERIF);
        headline.setLineSpacing(0, 1.08f);
        spaced(column, headline, 20, dp);
        TextView body = text(c, text, 18, fg, Typeface.SERIF);
        body.setLineSpacing(0, 1.4f);
        spaced(column, body, 16, dp);
        if (status != null && !status.isEmpty()) spaced(column, text(c, status, 14, fg, Typeface.SANS_SERIF), 32, dp);
        if (button != null) {
            Button close = new Button(c);
            close.setText(button);
            close.setOnClickListener(onButton);
            spaced(column, close, 28, dp);
        }
        if (footnote != null) {
            TextView note = text(c, footnote, 12, fg, Typeface.SANS_SERIF);
            note.setAlpha(0.65f);
            spaced(column, note, 28, dp);
        }

        ScrollView scroll = new ScrollView(c);
        scroll.setFillViewport(true);
        if (BlockScreen.GARDEN.equals(style)) {
            // blocked.css: a soft green glow rising from the lower left.
            GradientDrawable glow = new GradientDrawable(GradientDrawable.Orientation.BL_TR, new int[] { 0xFFD6E2D1, background(style), background(style) });
            scroll.setBackground(glow);
        } else {
            scroll.setBackgroundColor(background(style));
        }
        LinearLayout center = new LinearLayout(c);
        center.setGravity(Gravity.CENTER);
        center.addView(column, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        scroll.addView(center, new ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        return scroll;
    }

    private static TextView text(Context c, String value, int sp, int color, Typeface face) {
        TextView view = new TextView(c);
        view.setText(value);
        view.setTextSize(sp);
        view.setTextColor(color);
        view.setTypeface(face);
        view.setGravity(Gravity.CENTER);
        return view;
    }

    private static void spaced(LinearLayout column, View view, int topDp, float dp) {
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        params.topMargin = Math.round(topDp * dp);
        column.addView(view, params);
    }

    /** Decodes no larger than the screen needs; the bitmap is dropped with the view. */
    static Bitmap decode(File file, int maxWidth) {
        if (!file.isFile()) return null;
        BitmapFactory.Options bounds = new BitmapFactory.Options();
        bounds.inJustDecodeBounds = true;
        BitmapFactory.decodeFile(file.getPath(), bounds);
        BitmapFactory.Options options = new BitmapFactory.Options();
        options.inSampleSize = 1;
        while (bounds.outWidth / (options.inSampleSize * 2) >= maxWidth) options.inSampleSize *= 2;
        return BitmapFactory.decodeFile(file.getPath(), options);
    }
}

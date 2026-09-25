package io.github.limpy183dev.still;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Bitmap;
import android.graphics.ImageDecoder;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.Editable;
import android.text.TextWatcher;
import android.util.AtomicFile;
import android.view.View;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.RadioGroup;
import android.widget.Toast;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.util.ArrayList;
import java.util.List;

/** Chooses the block screen for future sessions, like Settings → Website block screens on Windows. */
public final class BlockScreenActivity extends Activity {
    /** The chosen image, re-encoded; kept under the same 180 KB budget as on Windows. */
    static final String IMAGE = "block-screen.webp";
    private static final int PICK = 1, MAX_BYTES = 180_000, MAX_SIDE = 1200;

    private final Handler handler = new Handler(Looper.getMainLooper());
    private final Runnable preview = this::preview;
    private RadioGroup modes;
    private EditText title, text, redirect;
    private boolean hasImage;

    static BlockScreen saved(Context c) {
        try {
            JSONObject o = new JSONObject(prefs(c).getString("blockScreen", "{}"));
            return BlockScreen.of(o.optString("mode", BlockScreen.GARDEN), o.optString("title"), o.optString("text"),
                    o.optString("redirect"), o.optBoolean("image") && new File(c.getFilesDir(), IMAGE).isFile(), new ArrayList<>());
        } catch (JSONException | IllegalArgumentException e) {
            return BlockScreen.DEFAULT;
        }
    }

    private static SharedPreferences prefs(Context c) { return c.getSharedPreferences("prefs", MODE_PRIVATE); }

    /** The user-facing name of a screen, for the main screen's summary. */
    static int name(String mode) {
        switch (mode) {
            case BlockScreen.DUSK: return R.string.screen_dusk;
            case BlockScreen.PAPER: return R.string.screen_paper;
            case BlockScreen.CUSTOM: return R.string.screen_custom;
            case BlockScreen.REDIRECT: return R.string.screen_redirect;
            default: return R.string.screen_garden;
        }
    }

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        setContentView(R.layout.activity_block_screen);
        modes = findViewById(R.id.modes);
        title = findViewById(R.id.custom_title);
        text = findViewById(R.id.custom_text);
        redirect = findViewById(R.id.redirect_url);

        BlockScreen current = saved(this);
        hasImage = current.image;
        title.setText(current.title);
        text.setText(current.text);
        redirect.setText(current.redirect);
        modes.check(idOf(current.mode));
        modes.setOnCheckedChangeListener((group, id) -> update());
        TextWatcher typing = new TextWatcher() {
            @Override public void beforeTextChanged(CharSequence s, int a, int b, int c) { }
            @Override public void onTextChanged(CharSequence s, int a, int b, int c) { }
            @Override public void afterTextChanged(Editable s) { handler.removeCallbacks(preview); handler.postDelayed(preview, 300); }
        };
        title.addTextChangedListener(typing);
        text.addTextChangedListener(typing);
        findViewById(R.id.choose_image).setOnClickListener(v -> startActivityForResult(new Intent(Intent.ACTION_OPEN_DOCUMENT)
                .addCategory(Intent.CATEGORY_OPENABLE).setType("image/*")
                .putExtra(Intent.EXTRA_MIME_TYPES, new String[] { "image/png", "image/jpeg", "image/webp" }), PICK));
        findViewById(R.id.remove_image).setOnClickListener(v -> { hasImage = false; update(); });
        findViewById(R.id.save_screen).setOnClickListener(v -> save());
        update();
    }

    private String mode() {
        int id = modes.getCheckedRadioButtonId();
        if (id == R.id.mode_dusk) return BlockScreen.DUSK;
        if (id == R.id.mode_paper) return BlockScreen.PAPER;
        if (id == R.id.mode_custom) return BlockScreen.CUSTOM;
        if (id == R.id.mode_redirect) return BlockScreen.REDIRECT;
        return BlockScreen.GARDEN;
    }

    private static int idOf(String mode) {
        switch (mode) {
            case BlockScreen.DUSK: return R.id.mode_dusk;
            case BlockScreen.PAPER: return R.id.mode_paper;
            case BlockScreen.CUSTOM: return R.id.mode_custom;
            case BlockScreen.REDIRECT: return R.id.mode_redirect;
            default: return R.id.mode_garden;
        }
    }

    private void update() {
        String mode = mode();
        findViewById(R.id.custom_fields).setVisibility(BlockScreen.CUSTOM.equals(mode) ? View.VISIBLE : View.GONE);
        findViewById(R.id.redirect_fields).setVisibility(BlockScreen.REDIRECT.equals(mode) ? View.VISIBLE : View.GONE);
        findViewById(R.id.remove_image).setVisibility(hasImage ? View.VISIBLE : View.GONE);
        preview();
    }

    private void preview() {
        String mode = mode();
        BlockScreen screen = BlockScreen.of(BlockScreen.REDIRECT.equals(mode) ? BlockScreen.GARDEN : mode,
                title.getText().toString(), text.getText().toString(), "", hasImage, new ArrayList<>());
        FrameLayout frame = findViewById(R.id.preview);
        frame.setClipToOutline(true); // Rounds the preview to the card's corners.
        frame.removeAllViews();
        frame.addView(BlockScreenView.build(this, screen.style(), screen.image ? new File(getFilesDir(), IMAGE) : null,
                screen.headline(), screen.body(), getString(R.string.cover_text, "youtube.com", Store.time(this, System.currentTimeMillis() + 3_600_000)),
                getString(R.string.screen_footnote), null, null));
    }

    private void save() {
        List<String> blocked = new ArrayList<>();
        for (String site : prefs(this).getString("websites", "").split("\n")) if (!site.isEmpty()) blocked.add(site);
        try {
            BlockScreen screen = BlockScreen.of(mode(), title.getText().toString(), text.getText().toString(),
                    redirect.getText().toString(), hasImage, blocked);
            prefs(this).edit().putString("blockScreen", new JSONObject().put("mode", screen.mode).put("title", screen.title)
                    .put("text", screen.text).put("redirect", screen.redirect).put("image", screen.image).toString()).apply();
            finish();
        } catch (IllegalArgumentException e) {
            Toast.makeText(this, e.getMessage(), Toast.LENGTH_LONG).show();
        } catch (JSONException e) {
            Toast.makeText(this, R.string.save_failed, Toast.LENGTH_LONG).show();
        }
    }

    @Override
    protected void onActivityResult(int request, int result, Intent data) {
        if (request != PICK || result != RESULT_OK || data == null || data.getData() == null) return;
        ImageDecoder.Source source = ImageDecoder.createSource(getContentResolver(), data.getData());
        File target = new File(getFilesDir(), IMAGE);
        new Thread(() -> {
            boolean ok = importImage(source, target);
            runOnUiThread(() -> {
                if (isDestroyed()) return;
                if (ok) hasImage = true; else Toast.makeText(this, R.string.screen_image_failed, Toast.LENGTH_LONG).show();
                update();
            });
        }).start();
    }

    /** Shrinks and re-encodes once, so the block screen never loads a large original. */
    private static boolean importImage(ImageDecoder.Source source, File target) {
        try {
            Bitmap bitmap = ImageDecoder.decodeBitmap(source, (decoder, info, src) -> {
                int w = info.getSize().getWidth(), h = info.getSize().getHeight();
                float scale = Math.min(1f, (float) MAX_SIDE / Math.max(w, h));
                decoder.setTargetSize(Math.max(1, Math.round(w * scale)), Math.max(1, Math.round(h * scale)));
                decoder.setAllocator(ImageDecoder.ALLOCATOR_SOFTWARE);
            });
            byte[] bytes;
            int quality = 85;
            do {
                ByteArrayOutputStream out = new ByteArrayOutputStream();
                bitmap.compress(Bitmap.CompressFormat.WEBP_LOSSY, quality, out);
                bytes = out.toByteArray();
                quality -= 10;
                if (bytes.length > MAX_BYTES && quality < 35) {
                    bitmap = Bitmap.createScaledBitmap(bitmap, bitmap.getWidth() * 3 / 4, bitmap.getHeight() * 3 / 4, true);
                    quality = 85;
                }
            } while (bytes.length > MAX_BYTES && bitmap.getWidth() > 64);
            bitmap.recycle();
            AtomicFile file = new AtomicFile(target);
            FileOutputStream stream = file.startWrite();
            try {
                stream.write(bytes);
                file.finishWrite(stream);
            } catch (IOException e) {
                file.failWrite(stream);
                throw e;
            }
            return true;
        } catch (IOException | RuntimeException e) {
            return false;
        }
    }
}

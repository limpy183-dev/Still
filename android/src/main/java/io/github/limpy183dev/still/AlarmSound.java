package io.github.limpy183dev.still;

import android.content.Context;
import android.media.AudioAttributes;
import android.media.AudioFormat;
import android.media.AudioTrack;
import android.media.MediaPlayer;
import android.os.Handler;
import android.os.Looper;

/**
 * An alarm's sound, on the alarm volume. The built-in sounds are the Windows ones (app/alert-sound.js),
 * synthesised once into a 3-second buffer that the audio hardware loops, so playing costs no CPU work.
 * Your own sound plays from Still's copy of the file; if it can't play, the chime plays instead.
 * One sound at a time, stopped after a minute at most. Main thread only.
 */
final class AlarmSound {
    static final long MAX_MS = 60_000;
    private static final int RATE = 22050;
    /** Loudness of each note at 100% volume, before the phone's alarm volume. */
    private static final double PEAK = 0.3;
    private static final Handler handler = new Handler(Looper.getMainLooper());
    private static final Runnable stop = AlarmSound::stop;
    private static AudioTrack track;
    private static MediaPlayer player;

    private AlarmSound() {}

    static void play(Context c, Alerts.Alert a) {
        stop();
        if ("silent".equals(a.sound) || a.volume == 0) return;
        float volume = a.volume / 100f;
        AudioAttributes attributes = new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ALARM)
                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build();
        handler.postDelayed(stop, MAX_MS);
        if ("custom".equals(a.sound) && a.soundFile != null) {
            MediaPlayer p = player = new MediaPlayer();
            try {
                p.setAudioAttributes(attributes);
                p.setDataSource(AlertStore.media(c, a.soundFile).getPath());
                p.setLooping(true);
                p.setVolume(volume, volume);
                p.setOnPreparedListener(MediaPlayer::start);
                p.setOnErrorListener((mp, what, extra) -> { chime(attributes, volume); return true; });
                p.prepareAsync();
            } catch (java.io.IOException | RuntimeException e) {
                chime(attributes, volume);
            }
            return;
        }
        tone(a.sound, attributes, volume);
    }

    private static void chime(AudioAttributes attributes, float volume) {
        releasePlayer();
        tone("chime", attributes, volume);
    }

    private static void tone(String sound, AudioAttributes attributes, float volume) {
        short[] samples = melody(sound);
        try {
            track = new AudioTrack.Builder().setAudioAttributes(attributes)
                    .setAudioFormat(new AudioFormat.Builder().setEncoding(AudioFormat.ENCODING_PCM_16BIT).setSampleRate(RATE)
                            .setChannelMask(AudioFormat.CHANNEL_OUT_MONO).build())
                    .setBufferSizeInBytes(samples.length * 2).setTransferMode(AudioTrack.MODE_STATIC).build();
            track.write(samples, 0, samples.length);
            track.setLoopPoints(0, samples.length, -1);
            track.setVolume(volume);
            track.play();
        } catch (RuntimeException e) {
            releaseTrack(); // No sound output: the screen and notification still show.
        }
    }

    /** One 3-second loop of playAlertSound's notes: 0.27 s apart, a 20 ms rise and a 0.9 s fade. */
    static short[] melody(String sound) {
        double[] notes;
        switch (sound) {
            case "bloom": notes = new double[] { 261.63, 329.63, 392, 523.25 }; break;
            case "bell": notes = new double[] { 880, 660, 880 }; break;
            case "pulse": notes = new double[] { 440, 440, 554.37, 554.37 }; break;
            default: notes = new double[] { 659.25, 830.61, 987.77 };
        }
        boolean triangle = "pulse".equals(sound);
        double[] mix = new double[RATE * 3];
        for (int n = 0; n < notes.length; n++) {
            int from = (int) (n * 0.27 * RATE);
            for (int i = 0; i < RATE && from + i < mix.length; i++) {
                double t = (double) i / RATE, phase = notes[n] * t % 1;
                double wave = triangle ? 1 - 4 * Math.abs(phase - 0.5) : Math.sin(2 * Math.PI * phase);
                double gain = t < 0.02 ? PEAK * t / 0.02 : t < 0.9 ? PEAK * Math.pow(0.001 / PEAK, (t - 0.02) / 0.88) : 0;
                mix[from + i] += wave * gain;
            }
        }
        short[] out = new short[mix.length];
        for (int i = 0; i < mix.length; i++) out[i] = (short) Math.round(Math.max(-1, Math.min(1, mix[i])) * Short.MAX_VALUE);
        return out;
    }

    static void stop() {
        handler.removeCallbacks(stop);
        releaseTrack();
        releasePlayer();
    }

    private static void releaseTrack() {
        if (track == null) return;
        try { track.stop(); } catch (IllegalStateException ignored) { }
        track.release();
        track = null;
    }

    private static void releasePlayer() {
        if (player == null) return;
        player.release();
        player = null;
    }
}

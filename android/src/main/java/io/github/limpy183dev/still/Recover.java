package io.github.limpy183dev.still;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/**
 * Emergency release, the Android counterpart of {@code Still.Guard.exe --recover}. The manifest requires
 * android.permission.DUMP, which only the system and a USB-debugging shell hold, so other apps cannot
 * send it:
 *
 *   adb shell am broadcast -n io.github.limpy183dev.still/.Recover
 *
 * It ends the session as "recovered" and keeps history.
 */
public final class Recover extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        Store.finish(context, "recovered");
        setResultData("Still: session released");
    }
}

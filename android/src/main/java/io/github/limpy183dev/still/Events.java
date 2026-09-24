package io.github.limpy183dev.still;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/**
 * The session-end alarm and date/time changes. It only re-reads the state and the clocks, so a broadcast
 * from anywhere else can never end or change a session.
 */
public final class Events extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        String action = intent.getAction();
        // The end alarm has no action; anything else must be the system's time-change broadcast.
        if (action == null || Intent.ACTION_TIME_CHANGED.equals(action)) Store.reanchor(context);
    }
}

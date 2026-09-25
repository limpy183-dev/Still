package io.github.limpy183dev.still;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/**
 * The session-end and alert alarms, boot, and date, time and time-zone changes. It only re-reads the state and
 * the clocks, so a broadcast from anywhere else can never end or change a session.
 */
public final class Events extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        // Whatever the broadcast (end alarm, alert alarm, boot, date, time or time zone change, app update),
        // both checks only act on what is actually due, so an unexpected sender can't change anything.
        Store.reanchor(context);
        AlertStore.tick(context);
    }
}

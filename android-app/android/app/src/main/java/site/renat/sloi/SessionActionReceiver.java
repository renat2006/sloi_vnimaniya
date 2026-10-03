package site.renat.sloi;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Bundle;
import android.app.PendingIntent;
import androidx.core.app.RemoteInput;

/** Обрабатывает быстрый ввод мысли из живого уведомления и возвращает пользователя в сессию. */
public final class SessionActionReceiver extends BroadcastReceiver {
    static final String ACTION_NOTE = "site.renat.sloi.NOTIFICATION_NOTE";
    static final String ACTION_GO = "site.renat.sloi.NOTIFICATION_GO";
    static final String EXTRA_GO = "go";
    static final String NOTE_KEY = "sloi_note";

    static PendingIntent go(Context ctx, String target) {
        Intent i = new Intent(ctx, SessionActionReceiver.class)
            .setAction(ACTION_GO)
            .putExtra(EXTRA_GO, target);
        return PendingIntent.getBroadcast(ctx, target.hashCode(), i,
            PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    static PendingIntent note(Context ctx) {
        Intent i = new Intent(ctx, SessionActionReceiver.class).setAction(ACTION_NOTE);
        return PendingIntent.getBroadcast(ctx, 2002, i,
            PendingIntent.FLAG_MUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    @Override
    public void onReceive(Context ctx, Intent intent) {
        Bundle results = RemoteInput.getResultsFromIntent(intent);
        CharSequence value = results == null ? null : results.getCharSequence(NOTE_KEY);
        String text = value == null ? "" : value.toString().trim();
        if (text.length() > 140) text = text.substring(0, 140);
        if (ACTION_NOTE.equals(intent.getAction())) {
            ctx.startActivity(Links.intent(ctx, "note", text));
            return;
        }
        String target = intent.getStringExtra(EXTRA_GO);
        if (target != null && !target.isEmpty()) ctx.startActivity(Links.intent(ctx, target));
    }
}

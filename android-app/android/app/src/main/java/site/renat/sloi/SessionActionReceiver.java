package site.renat.sloi;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Bundle;
import androidx.core.app.RemoteInput;

/** Обрабатывает быстрый ввод мысли из живого уведомления и возвращает пользователя в сессию. */
public final class SessionActionReceiver extends BroadcastReceiver {
    static final String ACTION_NOTE = "site.renat.sloi.NOTIFICATION_NOTE";
    static final String NOTE_KEY = "sloi_note";

    @Override
    public void onReceive(Context ctx, Intent intent) {
        Bundle results = RemoteInput.getResultsFromIntent(intent);
        CharSequence value = results == null ? null : results.getCharSequence(NOTE_KEY);
        String text = value == null ? "" : value.toString().trim();
        if (text.length() > 140) text = text.substring(0, 140);
        ctx.startActivity(Links.intent(ctx, "note", text));
    }
}

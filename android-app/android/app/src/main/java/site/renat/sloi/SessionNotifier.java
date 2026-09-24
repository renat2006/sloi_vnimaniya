package site.renat.sloi;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.Context;
import android.os.Build;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import java.util.ArrayList;
import java.util.List;
import org.json.JSONArray;
import org.json.JSONException;

/** Уведомление «сеанс идёт»: обратный отсчёт, слои сеанса в прогрессе, на Android 16 — Live Update в статус-баре. */
final class SessionNotifier {
    static final String CHANNEL = "session_live";
    static final int ID = 2001;
    private static final int FOCUS = 0xFFE3D2A6, STONE = 0xFFA9A88A, DRIFT = 0xFF93C8D8, TRACK = 0x33E8E2D6;

    static void update(Context ctx, SessionState s) {
        NotificationManagerCompat nm = NotificationManagerCompat.from(ctx);
        if (!s.active || !s.live || !nm.areNotificationsEnabled()) {
            nm.cancel(ID);
            return;
        }
        ensureChannel(ctx);
        long remaining = s.remaining();
        String title = s.drift ? "Разрыв растёт" : "Фокус";
        String text = (s.task.isEmpty() ? "Сеанс идёт" : s.task) + " · осталось " + SessionState.minutesRu(remaining);

        NotificationCompat.Builder b = new NotificationCompat.Builder(ctx, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_sloi)
            .setContentTitle(title)
            .setContentText(text)
            .setColor(0xFFD8CBB0)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setCategory(NotificationCompat.CATEGORY_PROGRESS)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setContentIntent(Links.open(ctx, "stage"))
            .setShowWhen(true)
            .setWhen(s.endAt())
            .setUsesChronometer(true)
            .setChronometerCountDown(true)
            .setTimeoutAfter(remaining + 1500)
            .setRequestPromotedOngoing(true)
            .addAction(0, "Завершить", Links.open(ctx, "finish"));

        int capSec = (int) Math.max(1, s.capacityMs / 1000);
        int elapsedSec = (int) Math.min(capSec, s.elapsed() / 1000);
        NotificationCompat.ProgressStyle ps = new NotificationCompat.ProgressStyle()
            .setStyledByProgress(false)
            .setProgress(elapsedSec)
            .setProgressSegments(segments(s, capSec));
        b.setStyle(ps);
        nm.notify(ID, b.build());
    }

    private static List<NotificationCompat.ProgressStyle.Segment> segments(SessionState s, int capSec) {
        List<NotificationCompat.ProgressStyle.Segment> out = new ArrayList<>();
        JSONArray live = s.liveSegments();
        int used = 0;
        try {
            for (int i = 0; i < live.length(); i++) {
                JSONArray seg = live.getJSONArray(i);
                int len = (int) Math.max(1, seg.getLong(1) / 1000);
                if (used + len > capSec) len = capSec - used;
                if (len <= 0) break;
                int type = seg.getInt(0);
                out.add(new NotificationCompat.ProgressStyle.Segment(len)
                    .setColor(type == SessionState.DRIFT ? DRIFT : type == SessionState.STONE ? STONE : FOCUS));
                used += len;
            }
        } catch (JSONException ignored) {
        }
        if (used < capSec) out.add(new NotificationCompat.ProgressStyle.Segment(capSec - used).setColor(TRACK));
        return out;
    }

    static void cancel(Context ctx) {
        NotificationManagerCompat.from(ctx).cancel(ID);
    }

    private static void ensureChannel(Context ctx) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationChannel ch = new NotificationChannel(CHANNEL, "Сеанс идёт", NotificationManager.IMPORTANCE_LOW);
        ch.setDescription("Таймер и слои текущего сеанса");
        ch.setShowBadge(false);
        ctx.getSystemService(NotificationManager.class).createNotificationChannel(ch);
    }
}

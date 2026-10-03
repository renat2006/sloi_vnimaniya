package site.renat.sloi;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.app.RemoteInput;
import java.util.ArrayList;
import java.util.List;
import org.json.JSONArray;
import org.json.JSONException;

/** Уведомление «сеанс идёт»: обратный отсчёт, слои сеанса в прогрессе, на Android 16 — Live Update в статус-баре. */
final class SessionNotifier {
    static final String CHANNEL = "session_live";
    static final int ID = 2001;
    private static final int FOCUS = 0xFFE3D2A6, STONE = 0xFFA9A88A, DRIFT = 0xFF93C8D8, TRACK = 0x33E8E2D6;
    private static final String NOTE_KEY = SessionActionReceiver.NOTE_KEY;
    private static long lastUpdateAt;
    private static String lastFingerprint = "";

    static void update(Context ctx, SessionState s) {
        NotificationManagerCompat nm = NotificationManagerCompat.from(ctx);
        if (!s.active || !s.live || !nm.areNotificationsEnabled()) {
            nm.cancel(ID);
            lastUpdateAt = 0;
            lastFingerprint = "";
            return;
        }
        ensureChannel(ctx);
        long remaining = s.remaining();
        String fingerprint = s.drift + ":" + s.layers.length() + ":" + (remaining / 5000);
        long now = System.currentTimeMillis();
        // widgetSync обновляет состояние каждые две секунды. Уведомлению достаточно
        // пяти секунд, а смена слоя/режима всё равно проходит сразу.
        if (now - lastUpdateAt < 5000 && fingerprint.equals(lastFingerprint)) return;
        lastUpdateAt = now;
        lastFingerprint = fingerprint;
        String title = s.drift ? "Возвращение к фокусу" : "Фокус продолжается";
        String text = (s.task.isEmpty() ? "Сеанс внимания" : s.task) + " · осталось " + SessionState.minutesRu(remaining);

        NotificationCompat.Builder b = new NotificationCompat.Builder(ctx, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_sloi)
            .setContentTitle(title)
            .setContentText(text)
            .setColor(0xFFD8CBB0)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setSilent(true)
            .setCategory(NotificationCompat.CATEGORY_PROGRESS)
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .setPublicVersion(new NotificationCompat.Builder(ctx, CHANNEL)
                .setSmallIcon(R.drawable.ic_stat_sloi)
                .setContentTitle("Сеанс внимания идёт")
                .setContentText("Откройте приложение, чтобы продолжить")
                .setCategory(NotificationCompat.CATEGORY_PROGRESS)
                .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
                .setSilent(true)
                .build())
            .setContentIntent(Links.open(ctx, "stage"))
            .setShowWhen(true)
            .setWhen(s.endAt())
            .setUsesChronometer(true)
            .setChronometerCountDown(true)
            .setTimeoutAfter(remaining + 1500)
            .addAction(0, "Завершить", Links.open(ctx, "finish"))
            .addAction(noteAction(ctx));

        if (Build.VERSION.SDK_INT >= 36) {
            NotificationManager platform = ctx.getSystemService(NotificationManager.class);
            if (platform != null && platform.canPostPromotedNotifications()) {
                b.setRequestPromotedOngoing(true);
            }
        }

        int capSec = (int) Math.max(1, s.capacityMs / 1000);
        int elapsedSec = (int) Math.min(capSec, s.elapsed() / 1000);
        if (Build.VERSION.SDK_INT >= 36) {
            NotificationCompat.ProgressStyle ps = new NotificationCompat.ProgressStyle()
                .setStyledByProgress(false)
                .setProgress(elapsedSec)
                .setProgressSegments(segments(s, capSec));
            b.setStyle(ps);
        } else {
            b.setProgress(capSec, elapsedSec, false);
        }
        nm.notify(ID, b.build());
    }

    private static NotificationCompat.Action noteAction(Context ctx) {
        Intent i = new Intent(ctx, SessionActionReceiver.class)
            .setAction(SessionActionReceiver.ACTION_NOTE);
        PendingIntent pi = PendingIntent.getBroadcast(ctx, 2002, i,
            PendingIntent.FLAG_MUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        RemoteInput input = new RemoteInput.Builder(NOTE_KEY)
            .setLabel("Мысль, которую нужно отложить")
            .setAllowFreeFormInput(true)
            .build();
        return new NotificationCompat.Action.Builder(R.drawable.ic_stat_sloi, "Отложить мысль", pi)
            .addRemoteInput(input)
            .setAllowGeneratedReplies(false)
            .build();
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
        lastUpdateAt = 0;
        lastFingerprint = "";
    }

    private static void ensureChannel(Context ctx) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationChannel ch = new NotificationChannel(CHANNEL, "Сеанс идёт", NotificationManager.IMPORTANCE_LOW);
        ch.setDescription("Таймер и слои текущего сеанса");
        ch.setShowBadge(false);
        ctx.getSystemService(NotificationManager.class).createNotificationChannel(ch);
    }
}

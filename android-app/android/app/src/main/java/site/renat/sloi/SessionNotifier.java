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
import androidx.core.graphics.drawable.IconCompat;
import java.util.ArrayList;
import java.util.List;
import org.json.JSONArray;
import org.json.JSONException;

/** Уведомление «сеанс идёт»: обратный отсчёт, слои сеанса в прогрессе, на Android 16 — Live Update в статус-баре. */
final class SessionNotifier {
    static final String CHANNEL = "session_live";
    static final String END_CHANNEL = "session_end";
    static final int ID = 2001;
    static final int END_ID = 2002;
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
        nm.cancel(END_ID);
        long remaining = s.remaining();
        String fingerprint = s.drift + ":" + s.layers.length() + ":" + (remaining / 5000);
        long now = System.currentTimeMillis();
        // widgetSync обновляет состояние каждые две секунды. Уведомлению достаточно
        // пяти секунд, а смена слоя/режима всё равно проходит сразу.
        if (now - lastUpdateAt < 5000 && fingerprint.equals(lastFingerprint)) return;
        lastUpdateAt = now;
        lastFingerprint = fingerprint;
        String title = s.drift ? "Возвращение к фокусу" : "Фокус продолжается";
        int breaks = breaks(s);
        int layers = s.liveSegments().length();
        String text = (s.task.isEmpty() ? "Сеанс внимания" : s.task) + " · " + SessionState.minutesRu(remaining)
            + " · " + layers + " слоёв" + (breaks > 0 ? " · разрывов " + breaks : " · без разрывов");
        String sub = s.streak > 0
            ? "серия " + s.streak + " дн. · сегодня " + SessionState.minutesRu(s.todayMs)
            : "первый керн дня — уже в работе";

        NotificationCompat.Builder b = new NotificationCompat.Builder(ctx, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_sloi)
            .setContentTitle(title)
            .setContentText(text)
            .setSubText(sub)
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
            .setShortCriticalText(s.drift ? "разрыв" : SessionState.minutesRu(remaining))
            .addAction(R.drawable.ic_action_sound, "Сменить звук", SessionActionReceiver.go(ctx, "music"))
            .addAction(noteAction(ctx));
        b.addAction(R.drawable.ic_action_stop, "Завершить", SessionActionReceiver.go(ctx, "finish&confirm=1"));

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
                .setProgressSegments(segments(s, capSec))
                .setProgressPoints(points(s, capSec))
                .setProgressTrackerIcon(IconCompat.createWithResource(ctx, R.drawable.ic_notification_grain))
                .setProgressStartIcon(IconCompat.createWithResource(ctx, R.drawable.ic_notification_spark))
                .setProgressEndIcon(IconCompat.createWithResource(ctx, R.drawable.ic_notification_core));
            b.setStyle(ps);
        } else {
            b.setProgress(capSec, elapsedSec, false);
        }
        nm.notify(ID, b.build());
    }

    /** Уведомление о готовом керне: действие пользователя нужно, поэтому оно не ongoing. */
    static void finished(Context ctx, SessionState s) {
        NotificationManagerCompat nm = NotificationManagerCompat.from(ctx);
        if (!nm.areNotificationsEnabled()) return;
        ensureEndChannel(ctx);
        int layerCount = s.liveSegmentsFull().length();
        int breakCount = breaks(s);
        String text = "Колба заполнена · " + layerCount + " слоёв · разрывов " + breakCount;
        String sub = s.streak > 0
            ? "серия " + s.streak + " дн. · сегодня " + SessionState.minutesRu(s.todayMs)
            : "керн ждёт извлечения";
        NotificationCompat.Builder b = new NotificationCompat.Builder(ctx, END_CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_sloi)
            .setContentTitle("Керн готов")
            .setContentText(text)
            .setSubText(sub)
            .setColor(0xFFD8CBB0)
            .setCategory(NotificationCompat.CATEGORY_EVENT)
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .setPublicVersion(new NotificationCompat.Builder(ctx, END_CHANNEL)
                .setSmallIcon(R.drawable.ic_stat_sloi)
                .setContentTitle("Сеанс завершён")
                .setContentText("Откройте приложение, чтобы извлечь керн")
                .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
                .setCategory(NotificationCompat.CATEGORY_EVENT)
                .build())
            .setContentIntent(Links.open(ctx, "stage"))
            .setAutoCancel(true)
            .setOnlyAlertOnce(true)
            .setTimeoutAfter(6 * 60 * 60 * 1000L)
            .addAction(R.drawable.ic_action_extract, "Извлечь керн", SessionActionReceiver.go(ctx, "stage"))
            .addAction(R.drawable.ic_action_plus, "Ещё 5 минут", SessionActionReceiver.go(ctx, "start&min=5"));
        nm.notify(END_ID, b.build());
    }

    private static NotificationCompat.Action noteAction(Context ctx) {
        PendingIntent pi = SessionActionReceiver.note(ctx);
        RemoteInput input = new RemoteInput.Builder(NOTE_KEY)
            .setLabel("Мысль, которую нужно отложить")
            .setAllowFreeFormInput(true)
            .build();
        return new NotificationCompat.Action.Builder(R.drawable.ic_action_note, "Отложить мысль", pi)
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

    private static List<NotificationCompat.ProgressStyle.Point> points(SessionState s, int capSec) {
        List<NotificationCompat.ProgressStyle.Point> out = new ArrayList<>();
        JSONArray live = s.liveSegments();
        int used = 0;
        try {
            for (int i = 0; i < live.length() - 1; i++) {
                JSONArray seg = live.getJSONArray(i);
                used += Math.max(1, (int) (seg.getLong(1) / 1000));
                if (used < capSec) {
                    int type = seg.getInt(0);
                    out.add(new NotificationCompat.ProgressStyle.Point(used)
                        .setColor(type == SessionState.DRIFT ? DRIFT : FOCUS));
                }
            }
        } catch (JSONException ignored) {
        }
        return out;
    }

    private static int breaks(SessionState s) {
        int count = 0;
        try {
            for (int i = 0; i < s.layers.length(); i++) {
                if (s.layers.getJSONArray(i).getInt(0) == SessionState.DRIFT) count++;
            }
        } catch (JSONException ignored) {
        }
        return count;
    }

    static void cancel(Context ctx) {
        NotificationManagerCompat nm = NotificationManagerCompat.from(ctx);
        nm.cancel(ID);
        nm.cancel(END_ID);
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

    private static void ensureEndChannel(Context ctx) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationChannel ch = new NotificationChannel(END_CHANNEL, "Окончание сеанса", NotificationManager.IMPORTANCE_DEFAULT);
        ch.setDescription("Один сигнал, когда время сеанса вышло");
        ch.setShowBadge(true);
        ctx.getSystemService(NotificationManager.class).createNotificationChannel(ch);
    }
}

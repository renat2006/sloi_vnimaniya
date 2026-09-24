package site.renat.sloi;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Build;
import android.os.SystemClock;
import android.view.View;
import android.widget.RemoteViews;

public class SloiWidgetProvider extends AppWidgetProvider {
    public static final String PREFS = "sloi_widget";
    static final String ACTION_END = "site.renat.sloi.WIDGET_END";
    private static final int DIM = 0xFF8A857B;
    private static final int BONE = 0xFFE8E2D6;
    private static final int COLD = 0xFF7F9BB8;

    @Override
    public void onUpdate(Context ctx, AppWidgetManager mgr, int[] ids) {
        for (int id : ids) mgr.updateAppWidget(id, build(ctx));
    }

    @Override
    public void onReceive(Context ctx, Intent intent) {
        if (ACTION_END.equals(intent.getAction())) {
            SharedPreferences p = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
            if (p.getBoolean("active", false)) {
                p.edit().putBoolean("active", false).putBoolean("timeUp", true).apply();
            }
            refreshAll(ctx);
            return;
        }
        super.onReceive(ctx, intent);
    }

    static void refreshAll(Context ctx) {
        AppWidgetManager mgr = AppWidgetManager.getInstance(ctx);
        int[] ids = mgr.getAppWidgetIds(new ComponentName(ctx, SloiWidgetProvider.class));
        if (ids.length == 0) return;
        RemoteViews v = build(ctx);
        for (int id : ids) mgr.updateAppWidget(id, v);
    }

    static void scheduleEnd(Context ctx, long endAt) {
        AlarmManager am = (AlarmManager) ctx.getSystemService(Context.ALARM_SERVICE);
        Intent i = new Intent(ctx, SloiWidgetProvider.class).setAction(ACTION_END);
        PendingIntent pi = PendingIntent.getBroadcast(ctx, 7, i, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        am.cancel(pi);
        if (endAt > System.currentTimeMillis() && am != null) {
            am.setAndAllowWhileIdle(AlarmManager.RTC, endAt, pi);
        }
    }

    private static PendingIntent open(Context ctx, String go) {
        Intent i = new Intent(ctx, MainActivity.class)
            .setAction(Intent.ACTION_VIEW)
            .setData(Uri.parse(ctx.getString(R.string.sloi_base_url) + "/?go=" + go))
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        return PendingIntent.getActivity(ctx, go.hashCode(), i, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    static RemoteViews build(Context ctx) {
        SharedPreferences p = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        RemoteViews v = new RemoteViews(ctx.getPackageName(), R.layout.widget_sloi);
        boolean active = p.getBoolean("active", false);
        boolean drift = p.getBoolean("drift", false);
        String task = p.getString("task", "");
        int depth = p.getInt("lastDepth", -1);

        if (active) {
            long startedAt = p.getLong("startedAt", System.currentTimeMillis());
            long elapsed = Math.max(0, System.currentTimeMillis() - startedAt);
            v.setViewVisibility(R.id.w_chrono, View.VISIBLE);
            v.setViewVisibility(R.id.w_big, View.GONE);
            v.setChronometer(R.id.w_chrono, SystemClock.elapsedRealtime() - elapsed, null, true);
            v.setTextViewText(R.id.w_status, drift ? "разрыв растёт" : "фокус");
            v.setTextColor(R.id.w_status, drift ? COLD : BONE);
            v.setTextViewText(R.id.w_sub, task.isEmpty() ? "сеанс идёт" : task);
            v.setOnClickPendingIntent(R.id.w_root, open(ctx, "stage"));
        } else {
            v.setViewVisibility(R.id.w_chrono, View.GONE);
            v.setViewVisibility(R.id.w_big, View.VISIBLE);
            v.setTextColor(R.id.w_status, DIM);
            if (p.getBoolean("timeUp", false)) {
                v.setTextViewText(R.id.w_big, "время вышло");
                v.setTextViewText(R.id.w_status, "сеанс завершён");
                v.setTextViewText(R.id.w_sub, "откройте, чтобы извлечь керн");
                v.setOnClickPendingIntent(R.id.w_root, open(ctx, "stage"));
            } else if (depth >= 0) {
                long ms = p.getLong("lastMs", 0);
                v.setTextViewText(R.id.w_big, depth + "%");
                v.setTextViewText(R.id.w_status, "последний керн · глубина фокуса");
                v.setTextViewText(R.id.w_sub, Math.max(1, Math.round(ms / 60000f)) + " мин · разрывов " + p.getInt("lastBreaks", 0));
                v.setOnClickPendingIntent(R.id.w_root, open(ctx, "ritual"));
            } else {
                v.setTextViewText(R.id.w_big, "Начать");
                v.setTextViewText(R.id.w_status, "колба пуста");
                v.setTextViewText(R.id.w_sub, "нажмите, чтобы начать сеанс");
                v.setOnClickPendingIntent(R.id.w_root, open(ctx, "ritual"));
            }
        }
        return v;
    }
}

package site.renat.sloi;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.appwidget.AppWidgetProviderInfo;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.os.Build;
import android.os.Bundle;
import android.os.SystemClock;
import android.util.SizeF;
import android.view.View;
import android.widget.FrameLayout;
import android.widget.RemoteViews;
import java.util.LinkedHashMap;
import java.util.Map;
import org.json.JSONArray;

public class SloiWidgetProvider extends AppWidgetProvider {
    static final String ACTION_END = "site.renat.sloi.WIDGET_END";
    static final String ACTION_TICK = "site.renat.sloi.WIDGET_TICK";
    private static final int DIM = 0xFF8A857B, BONE = 0xFFE8E2D6, COLD = 0xFF93C8D8, WARM = 0xFFE3D2A6;

    @Override
    public void onUpdate(Context ctx, AppWidgetManager mgr, int[] ids) {
        RemoteViews v = render(ctx, SessionState.load(ctx));
        for (int id : ids) mgr.updateAppWidget(id, v);
    }

    @Override
    public void onAppWidgetOptionsChanged(Context ctx, AppWidgetManager mgr, int id, Bundle options) {
        mgr.updateAppWidget(id, render(ctx, SessionState.load(ctx)));
    }

    @Override
    public void onReceive(Context ctx, Intent intent) {
        String a = intent.getAction();
        if (ACTION_END.equals(a)) {
            SharedPreferences p = ctx.getSharedPreferences(SessionState.PREFS, Context.MODE_PRIVATE);
            if (p.getBoolean("active", false)) {
                p.edit().putBoolean("active", false).putBoolean("timeUp", true).apply();
            }
            SessionNotifier.cancel(ctx);
            SloiTileService.requestRefresh(ctx);
            refreshAll(ctx);
            return;
        }
        if (ACTION_TICK.equals(a)) {
            SessionState s = SessionState.load(ctx);
            if (s.active) {
                refreshAll(ctx);
                SessionNotifier.update(ctx, s);
                schedule(ctx, s);
            }
            return;
        }
        super.onReceive(ctx, intent);
    }

    static void refreshAll(Context ctx) {
        AppWidgetManager mgr = AppWidgetManager.getInstance(ctx);
        int[] ids = mgr.getAppWidgetIds(new ComponentName(ctx, SloiWidgetProvider.class));
        if (ids.length == 0) return;
        RemoteViews v = render(ctx, SessionState.load(ctx));
        for (int id : ids) mgr.updateAppWidget(id, v);
    }

    /** Будильники: конец сеанса и минутный тик для колбы в виджете и прогресса в уведомлении. */
    static void schedule(Context ctx, SessionState s) {
        AlarmManager am = (AlarmManager) ctx.getSystemService(Context.ALARM_SERVICE);
        PendingIntent end = broadcast(ctx, ACTION_END, 7);
        PendingIntent tick = broadcast(ctx, ACTION_TICK, 8);
        am.cancel(end);
        am.cancel(tick);
        if (!s.active) return;
        long now = System.currentTimeMillis();
        long endAt = s.endAt();
        if (endAt > now) {
            boolean exact = Build.VERSION.SDK_INT < Build.VERSION_CODES.S || am.canScheduleExactAlarms();
            if (exact) am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, endAt, end);
            else am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, endAt, end);
            am.setAndAllowWhileIdle(AlarmManager.RTC, Math.min(now + 60_000, endAt), tick);
        }
    }

    private static PendingIntent broadcast(Context ctx, String action, int code) {
        return PendingIntent.getBroadcast(ctx, code, new Intent(ctx, SloiWidgetProvider.class).setAction(action),
            PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    // ── отрисовка ─────────────────────────────────────────────────────────────

    static RemoteViews render(Context ctx, SessionState s) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            Map<SizeF, RemoteViews> m = new LinkedHashMap<>();
            m.put(new SizeF(110f, 50f), bind(ctx, s, R.layout.widget_small));
            m.put(new SizeF(180f, 110f), bind(ctx, s, R.layout.widget_medium));
            m.put(new SizeF(250f, 190f), bind(ctx, s, R.layout.widget_large));
            return new RemoteViews(m);
        }
        return bind(ctx, s, R.layout.widget_medium);
    }

    static RemoteViews bind(Context ctx, SessionState s, int layout) {
        RemoteViews v = new RemoteViews(ctx.getPackageName(), layout);
        boolean small = layout == R.layout.widget_small, large = layout == R.layout.widget_large;
        String stats = statsLine(s);
        JSONArray segments;
        long total;
        boolean glow = false;

        if (s.active) {
            long elapsed = s.elapsed();
            v.setViewVisibility(R.id.w_chrono, View.VISIBLE);
            v.setViewVisibility(R.id.w_big, View.GONE);
            v.setChronometer(R.id.w_chrono, SystemClock.elapsedRealtime() - elapsed, null, true);
            v.setTextViewText(R.id.w_status, s.drift ? (small ? "разрыв" : "разрыв растёт") : "фокус");
            v.setTextColor(R.id.w_status, s.drift ? COLD : WARM);
            segments = s.liveSegments();
            total = s.capacityMs;
            glow = !s.drift;
            if (!small) v.setTextViewText(R.id.w_sub, s.task.isEmpty() ? "сеанс идёт" : s.task);
            v.setOnClickPendingIntent(R.id.w_root, Links.open(ctx, "stage"));
            if (large) {
                v.setViewVisibility(R.id.w_idle_actions, View.GONE);
                v.setViewVisibility(R.id.w_live_actions, View.VISIBLE);
                v.setChronometerCountDown(R.id.w_remain, true);
                v.setChronometer(R.id.w_remain, SystemClock.elapsedRealtime() + s.remaining(), null, true);
                v.setOnClickPendingIntent(R.id.w_finish, Links.open(ctx, "finish"));
            }
        } else {
            v.setViewVisibility(R.id.w_chrono, View.GONE);
            v.setViewVisibility(R.id.w_big, View.VISIBLE);
            v.setTextColor(R.id.w_status, DIM);
            String click = "ritual";
            if (s.timeUp) {
                v.setTextViewText(R.id.w_big, "Готово");
                v.setTextViewText(R.id.w_status, small ? "конец" : "время вышло");
                if (!small) v.setTextViewText(R.id.w_sub, "откройте, чтобы извлечь керн");
                segments = s.layers.length() > 0 ? s.liveSegmentsFull() : new JSONArray().put(new JSONArray().put(0).put(1L));
                total = Math.max(1, sum(segments));
                click = "stage";
            } else if (s.lastDepth >= 0) {
                v.setTextViewText(R.id.w_big, s.lastDepth + "%");
                v.setTextViewText(R.id.w_status, small ? "керн" : "последний керн");
                if (!small) v.setTextViewText(R.id.w_sub, (large ? "глубина фокуса · " : "") + Math.max(1, Math.round(s.lastMs / 60000f)) + " мин · разрывов " + s.lastBreaks);
                segments = s.lastLayers;
                total = Math.max(1, sum(segments));
            } else {
                v.setTextViewText(R.id.w_big, small ? "Старт" : "Начать");
                v.setTextViewText(R.id.w_status, small ? "пусто" : "колба пуста");
                if (!small) v.setTextViewText(R.id.w_sub, "нажмите, чтобы начать сеанс");
                segments = new JSONArray();
                total = 1;
            }
            v.setOnClickPendingIntent(R.id.w_root, Links.open(ctx, click));
            if (large) {
                v.setViewVisibility(R.id.w_idle_actions, View.VISIBLE);
                v.setViewVisibility(R.id.w_live_actions, View.GONE);
                v.setOnClickPendingIntent(R.id.w_start15, Links.open(ctx, "start&min=15"));
                v.setOnClickPendingIntent(R.id.w_start25, Links.open(ctx, "start&min=25"));
                v.setOnClickPendingIntent(R.id.w_start50, Links.open(ctx, "start&min=50"));
            }
        }
        if (large) v.setTextViewText(R.id.w_stats, stats);

        int w = small ? 60 : large ? 140 : 108, h = small ? 92 : large ? 210 : 162;
        v.setImageViewBitmap(R.id.w_flask, FlaskRenderer.draw(w, h, segments, total, glow));
        return v;
    }

    private static long sum(JSONArray segs) {
        long t = 0;
        for (int i = 0; i < segs.length(); i++) t += segs.optJSONArray(i) == null ? 0 : segs.optJSONArray(i).optLong(1);
        return t;
    }

    private static String statsLine(SessionState s) {
        StringBuilder sb = new StringBuilder();
        if (s.todayMs > 0) sb.append("сегодня ").append(SessionState.minutesRu(s.todayMs));
        if (s.streak > 0) {
            if (sb.length() > 0) sb.append(" · ");
            sb.append("серия ").append(s.streak).append(" дн.");
        }
        return sb.length() > 0 ? sb.toString() : "серия начнётся с первого керна";
    }

    // ── превью для выбора виджета (Android 15+) и отладка ───────────────────

    static void publishPreview(Context ctx) {
        if (Build.VERSION.SDK_INT < 35) return;
        try {
            SessionState d = new SessionState();
            d.active = true;
            d.live = true;
            d.startedAt = System.currentTimeMillis() - 9 * 60_000;
            d.capacityMs = 25 * 60_000;
            d.task = "глава 2 · разбор данных";
            d.todayMs = 84 * 60_000;
            d.streak = 4;
            d.layers = SessionState.arr("[[0,0,300000],[2,300000,360000],[0,360000,null]]");
            AppWidgetManager.getInstance(ctx).setWidgetPreview(new ComponentName(ctx, SloiWidgetProvider.class),
                AppWidgetProviderInfo.WIDGET_CATEGORY_HOME_SCREEN, render(ctx, d));
        } catch (Exception ignored) {
        }
    }

    /** Рисует виджет заданного размера в картинку — для проверки макетов без launcher. */
    static Bitmap renderToBitmap(Context ctx, SessionState s, int wDp, int hDp) {
        int layout = wDp >= 250 && hDp >= 190 ? R.layout.widget_large : wDp >= 180 && hDp >= 110 ? R.layout.widget_medium : R.layout.widget_small;
        float d = ctx.getResources().getDisplayMetrics().density;
        int w = Math.round(wDp * d), h = Math.round(hDp * d);
        Context app = ctx.getApplicationContext();
        View view = bind(app, s, layout).apply(app, new FrameLayout(app));
        view.measure(View.MeasureSpec.makeMeasureSpec(w, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(h, View.MeasureSpec.EXACTLY));
        view.layout(0, 0, w, h);
        Bitmap bmp = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888);
        view.draw(new Canvas(bmp));
        return bmp;
    }
}

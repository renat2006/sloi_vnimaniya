package site.renat.sloi;

import android.content.Context;
import android.content.SharedPreferences;
import org.json.JSONArray;
import org.json.JSONException;

/** Состояние сеанса и статистика: единый источник для виджета, уведомления и плитки. */
final class SessionState {
    static final String PREFS = "sloi_widget";
    static final int FOCUS = 0, STONE = 1, DRIFT = 2;

    boolean active, drift, timeUp, live;
    long startedAt, capacityMs;
    String task = "";
    JSONArray layers = new JSONArray();     // [[type, startMs, endMs|null], ...] относительно старта
    int lastDepth = -1, lastBreaks, streak;
    long lastMs, todayMs;
    JSONArray lastLayers = new JSONArray(); // [[type, durationMs], ...]

    static SessionState load(Context ctx) {
        SharedPreferences p = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        SessionState s = new SessionState();
        s.active = p.getBoolean("active", false);
        s.drift = p.getBoolean("drift", false);
        s.timeUp = p.getBoolean("timeUp", false);
        s.live = p.getBoolean("live", false);
        s.startedAt = p.getLong("startedAt", 0);
        s.capacityMs = p.getLong("capacityMs", 0);
        s.task = p.getString("task", "");
        s.lastDepth = p.getInt("lastDepth", -1);
        s.lastBreaks = p.getInt("lastBreaks", 0);
        s.lastMs = p.getLong("lastMs", 0);
        s.todayMs = p.getLong("todayMs", 0);
        s.streak = p.getInt("streak", 0);
        s.layers = arr(p.getString("layers", "[]"));
        s.lastLayers = arr(p.getString("lastLayers", "[]"));
        if (s.active && s.capacityMs > 0 && System.currentTimeMillis() - s.startedAt >= s.capacityMs) {
            s.active = false;
            s.timeUp = true;
        }
        return s;
    }

    long elapsed() {
        return Math.max(0, System.currentTimeMillis() - startedAt);
    }

    long remaining() {
        return Math.max(0, capacityMs - elapsed());
    }

    long endAt() {
        return startedAt + capacityMs;
    }

    /** Слои идущего сеанса как [[type, durationMs], ...]; открытый слой тянется до «сейчас». */
    JSONArray liveSegments() {
        JSONArray out = new JSONArray();
        long now = Math.min(elapsed(), capacityMs);
        try {
            for (int i = 0; i < layers.length(); i++) {
                JSONArray l = layers.getJSONArray(i);
                long start = l.getLong(1);
                long end = l.isNull(2) ? now : Math.min(l.getLong(2), now);
                if (end > start) out.put(new JSONArray().put(l.getInt(0)).put(end - start));
            }
        } catch (JSONException ignored) {
        }
        return out;
    }

    /** Слои завершившегося по времени сеанса: открытый слой доходит до ёмкости колбы. */
    JSONArray liveSegmentsFull() {
        JSONArray out = new JSONArray();
        try {
            for (int i = 0; i < layers.length(); i++) {
                JSONArray l = layers.getJSONArray(i);
                long start = l.getLong(1);
                long end = l.isNull(2) ? capacityMs : Math.min(l.getLong(2), capacityMs);
                if (end > start) out.put(new JSONArray().put(l.getInt(0)).put(end - start));
            }
        } catch (JSONException ignored) {
        }
        return out;
    }

    static JSONArray arr(String json) {
        try {
            return new JSONArray(json == null ? "[]" : json);
        } catch (JSONException e) {
            return new JSONArray();
        }
    }

    static String minutesRu(long ms) {
        long m = Math.round(ms / 60000.0);
        if (m < 60) return m + " мин";
        return (m / 60) + " ч " + (m % 60 == 0 ? "" : (m % 60) + " мин");
    }
}

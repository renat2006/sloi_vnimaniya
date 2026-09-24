package site.renat.sloi;

import android.app.StatusBarManager;
import android.appwidget.AppWidgetManager;
import android.content.ComponentName;
import android.content.Context;
import android.content.SharedPreferences;
import android.graphics.Bitmap;
import android.graphics.drawable.Icon;
import android.os.Build;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.os.VibratorManager;
import android.util.Base64;
import android.view.HapticFeedbackConstants;
import android.view.View;
import android.view.WindowManager;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.ByteArrayOutputStream;

@CapacitorPlugin(name = "SloiBridge")
public class SloiBridgePlugin extends Plugin {

    @Override
    public void load() {
        SloiWidgetProvider.publishPreview(getContext());
    }

    /** Единое состояние: питает виджет, уведомление «сеанс идёт» и плитку быстрых настроек. */
    @PluginMethod
    public void setState(PluginCall call) {
        Context ctx = getContext();
        JSObject d = call.getData();
        SharedPreferences.Editor e = ctx.getSharedPreferences(SessionState.PREFS, Context.MODE_PRIVATE).edit();
        boolean active = Boolean.TRUE.equals(call.getBoolean("active", false));
        e.putBoolean("active", active);
        e.putBoolean("drift", Boolean.TRUE.equals(call.getBoolean("drift", false)));
        e.putBoolean("live", Boolean.TRUE.equals(call.getBoolean("live", false)));
        e.putBoolean("timeUp", false);
        e.putLong("startedAt", d.optLong("startedAt", 0));
        e.putLong("capacityMs", d.optLong("capacityMs", 0));
        e.putString("task", call.getString("task", ""));
        JSArray layers = call.getArray("layers", new JSArray());
        e.putString("layers", layers.toString());
        if (d.has("todayMs")) e.putLong("todayMs", d.optLong("todayMs", 0));
        if (d.has("streak")) e.putInt("streak", call.getInt("streak", 0));
        if (d.has("lastDepth")) {
            e.putInt("lastDepth", call.getInt("lastDepth", -1));
            e.putLong("lastMs", d.optLong("lastMs", 0));
            e.putInt("lastBreaks", call.getInt("lastBreaks", 0));
            e.putString("lastLayers", call.getArray("lastLayers", new JSArray()).toString());
        }
        e.apply();

        SessionState s = SessionState.load(ctx);
        SloiWidgetProvider.schedule(ctx, s);
        SloiWidgetProvider.refreshAll(ctx);
        SessionNotifier.update(ctx, s);
        SloiTileService.requestRefresh(ctx);
        call.resolve(new JSObject());
    }

    @PluginMethod
    public void pinWidget(PluginCall call) {
        Context ctx = getContext();
        JSObject res = new JSObject();
        boolean ok = false;
        AppWidgetManager mgr = AppWidgetManager.getInstance(ctx);
        if (mgr.isRequestPinAppWidgetSupported()) {
            ok = mgr.requestPinAppWidget(new ComponentName(ctx, SloiWidgetProvider.class), null, null);
        }
        res.put("requested", ok);
        call.resolve(res);
    }

    /** Предлагает добавить плитку в быстрые настройки (Android 13+). */
    @PluginMethod
    public void addTile(PluginCall call) {
        Context ctx = getContext();
        JSObject res = new JSObject();
        if (Build.VERSION.SDK_INT < 33) {
            res.put("supported", false);
            call.resolve(res);
            return;
        }
        StatusBarManager sbm = ctx.getSystemService(StatusBarManager.class);
        sbm.requestAddTileService(new ComponentName(ctx, SloiTileService.class), "Слои внимания",
            Icon.createWithResource(ctx, R.drawable.ic_stat_sloi), ctx.getMainExecutor(), result -> {
                res.put("supported", true);
                res.put("result", result);
                call.resolve(res);
            });
    }

    /** Системный отклик: уважает настройки вибрации пользователя, на новых телефонах — настоящие примитивы. */
    @PluginMethod
    public void haptic(PluginCall call) {
        String kind = call.getString("kind", "tick");
        getBridge().executeOnMainThread(() -> {
            perform(kind);
            call.resolve();
        });
    }

    private void perform(String kind) {
        View view = getBridge().getWebView();
        int sdk = Build.VERSION.SDK_INT;
        switch (kind) {
            case "success":
                composition(new int[]{1, 2, 1}, new float[]{0.6f, 0.5f, 1f}, new int[]{0, 70, 90}, new long[]{0, 18, 60, 28});
                return;
            case "rupture":
                composition(new int[]{3, 4}, new float[]{0.9f, 0.5f}, new int[]{0, 70}, new long[]{0, 40, 60, 24});
                return;
            case "click":
                view.performHapticFeedback(HapticFeedbackConstants.KEYBOARD_TAP);
                return;
            case "soft":
                view.performHapticFeedback(HapticFeedbackConstants.VIRTUAL_KEY);
                return;
            case "heavy":
                view.performHapticFeedback(HapticFeedbackConstants.LONG_PRESS);
                return;
            case "confirm":
                view.performHapticFeedback(sdk >= 30 ? HapticFeedbackConstants.CONFIRM : HapticFeedbackConstants.KEYBOARD_TAP);
                return;
            case "reject":
                view.performHapticFeedback(sdk >= 30 ? HapticFeedbackConstants.REJECT : HapticFeedbackConstants.LONG_PRESS);
                return;
            default:
                view.performHapticFeedback(HapticFeedbackConstants.CLOCK_TICK);
        }
    }

    /** ids: 1 CLICK, 2 TICK, 3 THUD, 4 LOW_TICK; на старых устройствах — обычная волна. */
    private void composition(int[] ids, float[] scales, int[] delays, long[] wave) {
        Context ctx = getContext();
        Vibrator v = Build.VERSION.SDK_INT >= 31
            ? ctx.getSystemService(VibratorManager.class).getDefaultVibrator()
            : (Vibrator) ctx.getSystemService(Context.VIBRATOR_SERVICE);
        if (v == null || !v.hasVibrator()) return;
        try {
            if (Build.VERSION.SDK_INT >= 30) {
                int[] prim = new int[ids.length];
                for (int i = 0; i < ids.length; i++) {
                    prim[i] = ids[i] == 1 ? VibrationEffect.Composition.PRIMITIVE_CLICK
                        : ids[i] == 2 ? VibrationEffect.Composition.PRIMITIVE_TICK
                        : ids[i] == 3 ? VibrationEffect.Composition.PRIMITIVE_THUD
                        : VibrationEffect.Composition.PRIMITIVE_LOW_TICK;
                }
                if (v.areAllPrimitivesSupported(prim)) {
                    VibrationEffect.Composition c = VibrationEffect.startComposition();
                    for (int i = 0; i < prim.length; i++) c.addPrimitive(prim[i], scales[i], delays[i]);
                    v.vibrate(c.compose());
                    return;
                }
            }
            v.vibrate(VibrationEffect.createWaveform(wave, -1));
        } catch (SecurityException ignored) {
        }
    }

    /** Экран не гаснет во время сеанса — надёжнее, чем Wake Lock внутри WebView. */
    @PluginMethod
    public void keepAwake(PluginCall call) {
        boolean on = Boolean.TRUE.equals(call.getBoolean("on", false));
        getActivity().runOnUiThread(() -> {
            if (on) getActivity().getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            else getActivity().getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        });
        call.resolve();
    }

    /** Отладка: картинка виджета заданного размера и состояния (active | drift | idle | empty | timeup). */
    @PluginMethod
    public void debugWidget(PluginCall call) {
        SessionState s = new SessionState();
        String mode = call.getString("mode", "active");
        long now = System.currentTimeMillis();
        s.todayMs = 84 * 60_000L;
        s.streak = 4;
        s.live = true;
        if (mode.equals("active") || mode.equals("drift")) {
            s.active = true;
            s.drift = mode.equals("drift");
            s.startedAt = now - 9 * 60_000L;
            s.capacityMs = 25 * 60_000L;
            s.task = "глава 2 · разбор данных";
            s.layers = SessionState.arr(s.drift
                ? "[[0,0,300000],[2,300000,540000]]"
                : "[[0,0,300000],[2,300000,360000],[0,360000,null]]");
        } else if (mode.equals("idle")) {
            s.lastDepth = 93;
            s.lastMs = 25 * 60_000L;
            s.lastBreaks = 2;
            s.lastLayers = SessionState.arr("[[0,600000],[2,60000],[0,700000],[1,200000],[0,540000]]");
        } else if (mode.equals("timeup")) {
            s.timeUp = true;
            s.capacityMs = 25 * 60_000L;
            s.layers = SessionState.arr("[[0,0,900000],[2,900000,1000000],[0,1000000,null]]");
        }
        getBridge().executeOnMainThread(() -> {
            Bitmap bmp = SloiWidgetProvider.renderToBitmap(getContext(), s, call.getInt("w", 180), call.getInt("h", 110));
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            bmp.compress(Bitmap.CompressFormat.PNG, 100, out);
            JSObject res = new JSObject();
            res.put("png", Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP));
            call.resolve(res);
        });
    }
}

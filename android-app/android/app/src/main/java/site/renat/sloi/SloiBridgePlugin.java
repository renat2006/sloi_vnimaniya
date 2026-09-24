package site.renat.sloi;

import android.appwidget.AppWidgetManager;
import android.content.ComponentName;
import android.content.Context;
import android.os.Build;
import android.content.SharedPreferences;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "SloiBridge")
public class SloiBridgePlugin extends Plugin {

    /** Состояние для виджета: сеанс идёт / разрыв / последний керн. */
    @PluginMethod
    public void setState(PluginCall call) {
        Context ctx = getContext();
        SharedPreferences.Editor e = ctx.getSharedPreferences(SloiWidgetProvider.PREFS, Context.MODE_PRIVATE).edit();
        boolean active = Boolean.TRUE.equals(call.getBoolean("active", false));
        e.putBoolean("active", active);
        e.putBoolean("drift", Boolean.TRUE.equals(call.getBoolean("drift", false)));
        e.putLong("startedAt", call.getData().optLong("startedAt", 0));
        e.putLong("capacityMs", call.getData().optLong("capacityMs", 0));
        e.putString("task", call.getString("task", ""));
        e.putBoolean("timeUp", false);
        if (call.getData().has("lastDepth")) {
            e.putInt("lastDepth", call.getInt("lastDepth", -1));
            e.putLong("lastMs", call.getData().optLong("lastMs", 0));
            e.putInt("lastBreaks", call.getInt("lastBreaks", 0));
        }
        e.apply();
        long endAt = active ? call.getData().optLong("startedAt", 0) + call.getData().optLong("capacityMs", 0) : 0;
        SloiWidgetProvider.scheduleEnd(ctx, endAt);
        SloiWidgetProvider.refreshAll(ctx);
        call.resolve(new JSObject());
    }

    /** Показывает системный диалог «добавить виджет на главный экран». */
    @PluginMethod
    public void pinWidget(PluginCall call) {
        Context ctx = getContext();
        JSObject res = new JSObject();
        boolean ok = false;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            AppWidgetManager mgr = AppWidgetManager.getInstance(ctx);
            if (mgr.isRequestPinAppWidgetSupported()) {
                ok = mgr.requestPinAppWidget(new ComponentName(ctx, SloiWidgetProvider.class), null, null);
            }
        }
        res.put("requested", ok);
        call.resolve(res);
    }
}

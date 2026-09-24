package site.renat.sloi;

import android.content.ComponentName;
import android.content.Context;
import android.graphics.drawable.Icon;
import android.os.Build;
import android.service.quicksettings.Tile;
import android.service.quicksettings.TileService;

/** Плитка быстрых настроек: одно нажатие — начать сеанс или вернуться в идущий. */
public class SloiTileService extends TileService {
    @Override
    public void onStartListening() {
        refresh();
    }

    @Override
    public void onClick() {
        SessionState s = SessionState.load(this);
        String go = s.active || s.timeUp ? "stage" : "ritual";
        if (Build.VERSION.SDK_INT >= 34) {
            startActivityAndCollapse(Links.open(this, go));
        } else {
            startActivityAndCollapse(Links.intent(this, go));
        }
    }

    private void refresh() {
        Tile t = getQsTile();
        if (t == null) return;
        SessionState s = SessionState.load(this);
        t.setIcon(Icon.createWithResource(this, R.drawable.ic_stat_sloi));
        t.setLabel("Слои внимания");
        if (s.active) {
            t.setState(Tile.STATE_ACTIVE);
            if (Build.VERSION.SDK_INT >= 29) t.setSubtitle(s.drift ? "разрыв растёт" : "фокус · " + SessionState.minutesRu(s.remaining()));
        } else {
            t.setState(Tile.STATE_INACTIVE);
            if (Build.VERSION.SDK_INT >= 29) t.setSubtitle(s.timeUp ? "время вышло" : "начать сеанс");
        }
        t.updateTile();
    }

    static void requestRefresh(Context ctx) {
        try {
            TileService.requestListeningState(ctx, new ComponentName(ctx, SloiTileService.class));
        } catch (Exception ignored) {
        }
    }
}

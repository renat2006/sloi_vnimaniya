package site.renat.sloi;

import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.RectF;

/** Компактный artwork для большой области уведомления: состояние внимания читается без текста. */
final class NotificationArtwork {
    private static final int BG = 0xFF111519;
    private static final int BONE = 0xFFE8E2D6;
    private static final int WARM = 0xFFE3D2A6;
    private static final int COLD = 0xFF93C8D8;
    private static final int STONE = 0xFFA9A88A;

    static Bitmap draw(SessionState s, boolean finished) {
        int size = 192;
        Bitmap bmp = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888);
        Canvas c = new Canvas(bmp);
        float mid = size / 2f;

        Paint bg = new Paint(Paint.ANTI_ALIAS_FLAG);
        bg.setColor(BG);
        c.drawCircle(mid, mid, 86, bg);

        Paint ring = new Paint(Paint.ANTI_ALIAS_FLAG);
        ring.setStyle(Paint.Style.STROKE);
        ring.setStrokeWidth(8);
        ring.setStrokeCap(Paint.Cap.ROUND);
        ring.setColor(0x553A4552);
        c.drawCircle(mid, mid, 68, ring);

        float progress = s.capacityMs <= 0 ? 1f : Math.min(1f, Math.max(0f, s.elapsed() / (float) s.capacityMs));
        ring.setColor(finished ? WARM : s.drift ? COLD : WARM);
        c.drawArc(new RectF(68, 68, 124, 124), -90, Math.max(12, progress * 360), false, ring);

        Paint core = new Paint(Paint.ANTI_ALIAS_FLAG);
        core.setColor(finished ? WARM : s.drift ? COLD : 0xFFF6EACB);
        c.drawCircle(mid, mid, finished ? 28 : 23, core);
        core.setColor(BG);
        c.drawCircle(mid, mid, finished ? 11 : 8, core);

        Paint dot = new Paint(Paint.ANTI_ALIAS_FLAG);
        int count = Math.min(8, Math.max(1, s.layers.length()));
        for (int i = 0; i < count; i++) {
            double angle = -Math.PI / 2 + i * (Math.PI * 2 / count);
            float x = mid + (float) Math.cos(angle) * 79;
            float y = mid + (float) Math.sin(angle) * 79;
            dot.setColor(layerColor(s, i));
            c.drawCircle(x, y, i == count - 1 && !finished ? 6 : 4, dot);
        }

        if (finished) {
            Paint halo = new Paint(Paint.ANTI_ALIAS_FLAG);
            halo.setStyle(Paint.Style.STROKE);
            halo.setStrokeWidth(3);
            halo.setColor(0x88E3D2A6);
            c.drawCircle(mid, mid, 37, halo);
        }
        return bmp;
    }

    private static int layerColor(SessionState s, int index) {
        try {
            int type = s.layers.getJSONArray(Math.min(index, s.layers.length() - 1)).getInt(0);
            return type == SessionState.DRIFT ? COLD : type == SessionState.STONE ? STONE : WARM;
        } catch (Exception ignored) {
            return BONE;
        }
    }
}

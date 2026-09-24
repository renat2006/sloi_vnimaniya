package site.renat.sloi;

import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.LinearGradient;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.RectF;
import android.graphics.Shader;
import org.json.JSONArray;
import org.json.JSONException;

/** Рисует колбу со слоями — тем же языком, что и сайт: тёплый фокус, каменный переход, холодный разрыв. */
final class FlaskRenderer {
    private static final int BONE = 0xFFE8E2D6, INK = 0xFF08090B;
    private static final int FOCUS_LITE = 0xFFF6EACB, FOCUS = 0xFFE3D2A6, FOCUS_DEEP = 0xFF9C8047;
    private static final int STONE = 0xFFA9A88A, STONE_DEEP = 0xFF5E5C46;
    private static final int DRIFT_LITE = 0xFF55677A, DRIFT = 0xFF3A4552, DRIFT_EDGE = 0xFF93C8D8;

    static Bitmap draw(int w, int h, JSONArray segments, long totalMs, boolean glow) {
        Bitmap bmp = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888);
        Canvas c = new Canvas(bmp);
        float pad = Math.max(2f, w * 0.05f);
        float left = pad, right = w - pad, top = pad, bottom = h - pad;
        float bw = right - left, bh = bottom - top;

        float nl = left + bw * 0.34f, nr = left + bw * 0.66f;
        float neckBottom = top + bh * 0.26f, shoulder = top + bh * 0.42f;
        float r = bw * 0.16f;
        Path flask = new Path();
        flask.moveTo(nl, top);
        flask.lineTo(nr, top);
        flask.lineTo(nr, neckBottom);
        flask.quadTo(right, neckBottom + bh * 0.03f, right, shoulder);
        flask.lineTo(right, bottom - r);
        flask.quadTo(right, bottom, right - r, bottom);
        flask.lineTo(left + r, bottom);
        flask.quadTo(left, bottom, left, bottom - r);
        flask.lineTo(left, shoulder);
        flask.quadTo(left, neckBottom + bh * 0.03f, nl, neckBottom);
        flask.close();

        Paint p = new Paint(Paint.ANTI_ALIAS_FLAG);
        p.setStyle(Paint.Style.FILL);
        p.setColor((BONE & 0x00FFFFFF) | 0x0F000000);
        c.drawPath(flask, p);

        if (glow) {
            Paint g = new Paint(Paint.ANTI_ALIAS_FLAG);
            g.setStyle(Paint.Style.STROKE);
            g.setStrokeWidth(Math.max(2f, w * 0.06f));
            g.setColor(0x33E3D2A6);
            c.drawPath(flask, g);
        }

        c.save();
        c.clipPath(flask);
        long total = Math.max(1, totalMs);
        float y = bottom;
        try {
            for (int i = 0; segments != null && i < segments.length(); i++) {
                JSONArray s = segments.getJSONArray(i);
                int type = s.getInt(0);
                float hh = bh * (s.getLong(1) / (float) total);
                if (hh < 1f) hh = 1f;
                float y0 = Math.max(top, y - hh);
                int lite, deep;
                if (type == SessionState.DRIFT) { lite = DRIFT_LITE; deep = DRIFT; }
                else if (type == SessionState.STONE) { lite = STONE; deep = STONE_DEEP; }
                else { lite = FOCUS_LITE; deep = FOCUS_DEEP; }
                Paint band = new Paint(Paint.ANTI_ALIAS_FLAG);
                band.setShader(new LinearGradient(0, y0, 0, y, new int[]{lite, mid(lite, deep), deep}, null, Shader.TileMode.CLAMP));
                c.drawRect(left, y0, right, y, band);
                if (type == SessionState.DRIFT) {
                    Paint e = new Paint(Paint.ANTI_ALIAS_FLAG);
                    e.setColor(DRIFT_EDGE);
                    e.setAlpha(150);
                    c.drawRect(left, y0, right, y0 + Math.max(1f, h * 0.012f), e);
                }
                y = y0;
                if (y <= top) break;
            }
        } catch (JSONException ignored) {
        }
        c.restore();

        Paint o = new Paint(Paint.ANTI_ALIAS_FLAG);
        o.setStyle(Paint.Style.STROKE);
        o.setStrokeWidth(Math.max(1f, w * 0.03f));
        o.setColor((BONE & 0x00FFFFFF) | 0x70000000);
        c.drawPath(flask, o);

        Paint hl = new Paint(Paint.ANTI_ALIAS_FLAG);
        hl.setColor((BONE & 0x00FFFFFF) | 0x26000000);
        c.drawRoundRect(new RectF(left + bw * 0.14f, shoulder + bh * 0.04f, left + bw * 0.22f, bottom - bh * 0.1f), w * 0.02f, w * 0.02f, hl);
        return bmp;
    }

    private static int mid(int a, int b) {
        int r = ((a >> 16 & 255) + (b >> 16 & 255)) / 2, g = ((a >> 8 & 255) + (b >> 8 & 255)) / 2, bl = ((a & 255) + (b & 255)) / 2;
        return 0xFF000000 | r << 16 | g << 8 | bl;
    }

}

package site.renat.sloi;

import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;

final class Links {
    /** PendingIntent, открывающий приложение по ссылке вида {@code ?go=stage} или {@code ?go=start&min=25}. */
    static PendingIntent open(Context ctx, String query) {
        return PendingIntent.getActivity(ctx, query.hashCode(), intent(ctx, query),
            PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    static Intent intent(Context ctx, String query) {
        return base(ctx, query, null);
    }

    static Intent intent(Context ctx, String go, String text) {
        return base(ctx, go, text);
    }

    private static Intent base(Context ctx, String go, String text) {
        Uri.Builder url = Uri.parse(ctx.getString(R.string.sloi_base_url) + "/")
            .buildUpon();
        for (String part : go.split("&")) {
            int split = part.indexOf('=');
            if (split > 0) url.appendQueryParameter(part.substring(0, split), part.substring(split + 1));
            else if (!part.isEmpty()) url.appendQueryParameter(part, "");
        }
        if (text != null && !text.isEmpty()) url.appendQueryParameter("text", text);
        return new Intent(ctx, MainActivity.class)
            .setAction(Intent.ACTION_VIEW)
            .setData(url.build())
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
    }
}

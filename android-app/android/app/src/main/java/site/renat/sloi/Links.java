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
        return new Intent(ctx, MainActivity.class)
            .setAction(Intent.ACTION_VIEW)
            .setData(Uri.parse(ctx.getString(R.string.sloi_base_url) + "/?go=" + query))
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
    }
}

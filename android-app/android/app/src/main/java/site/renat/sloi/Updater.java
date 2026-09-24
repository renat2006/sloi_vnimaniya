package site.renat.sloi;

import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInstaller;
import android.os.Build;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;
import java.util.Locale;

/** Скачивает APK релиза, проверяет SHA-256 и передаёт системному установщику. Подпись проверяет сама Android. */
final class Updater {
    static final String RELEASES_PREFIX = "https://github.com/renat2006/sloi_vnimaniya/releases/download/";

    interface Progress {
        void onPercent(int percent);
    }

    static boolean allowed(String url) {
        return url != null && url.startsWith(RELEASES_PREFIX) && !url.contains("..");
    }

    static String expectedSha(String sumsUrl, String fileName) throws Exception {
        HttpURLConnection c = open(sumsUrl);
        try (InputStream in = c.getInputStream()) {
            String text = new String(in.readAllBytes(), "UTF-8");
            for (String line : text.split("\n")) {
                String[] p = line.trim().split("\\s+");
                if (p.length >= 2 && p[p.length - 1].replace("*", "").equals(fileName)) return p[0].toLowerCase(Locale.ROOT);
            }
        }
        throw new IllegalStateException("нет контрольной суммы для " + fileName);
    }

    static void install(Context ctx, String apkUrl, String sumsUrl, Progress progress) throws Exception {
        String name = apkUrl.substring(apkUrl.lastIndexOf('/') + 1);
        String expected = expectedSha(sumsUrl, name);

        HttpURLConnection c = open(apkUrl);
        long total = c.getContentLengthLong();
        PackageInstaller pi = ctx.getPackageManager().getPackageInstaller();
        PackageInstaller.SessionParams params = new PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            params.setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED);
        }
        int id = pi.createSession(params);
        PackageInstaller.Session session = pi.openSession(id);
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            try (InputStream in = c.getInputStream(); OutputStream out = session.openWrite("sloi.apk", 0, total > 0 ? total : -1)) {
                byte[] buf = new byte[64 * 1024];
                long done = 0;
                int last = -1, n;
                while ((n = in.read(buf)) > 0) {
                    md.update(buf, 0, n);
                    out.write(buf, 0, n);
                    done += n;
                    int pct = total > 0 ? (int) (done * 100 / total) : 0;
                    if (pct != last && pct % 2 == 0) {
                        last = pct;
                        progress.onPercent(pct);
                    }
                }
                session.fsync(out);
            }
            StringBuilder hex = new StringBuilder();
            for (byte b : md.digest()) hex.append(String.format("%02x", b));
            if (!hex.toString().equals(expected)) throw new SecurityException("контрольная сумма не совпала");

            Intent cb = new Intent(ctx, UpdateReceiver.class).setAction(UpdateReceiver.ACTION);
            PendingIntent pending = PendingIntent.getBroadcast(ctx, id, cb, PendingIntent.FLAG_MUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
            session.commit(pending.getIntentSender());
        } catch (Exception e) {
            session.abandon();
            throw e;
        } finally {
            session.close();
        }
    }

    private static HttpURLConnection open(String url) throws Exception {
        if (!allowed(url)) throw new SecurityException("адрес не из релизов проекта");
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setConnectTimeout(15000);
        c.setReadTimeout(30000);
        c.setInstanceFollowRedirects(true);
        c.setRequestProperty("User-Agent", "sloi-android-updater");
        if (c.getResponseCode() / 100 != 2) throw new IllegalStateException("HTTP " + c.getResponseCode());
        return c;
    }
}

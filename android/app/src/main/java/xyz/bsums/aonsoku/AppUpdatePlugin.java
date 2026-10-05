package xyz.bsums.aonsoku;

import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import android.util.Log;

import androidx.core.content.FileProvider;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.Arrays;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Updates the app from a GitHub release: downloads the release's APK into
 * the app's cache and hands it to Android's installer. Android only installs
 * it over this app if it is signed with the same key, so a wrong or
 * tampered file can't replace the app. The web app finds the release (see
 * src/utils/appUpdate.ts).
 *
 * Events: "progress" { fraction } while downloading.
 */
@CapacitorPlugin(name = "AppUpdate")
public class AppUpdatePlugin extends Plugin {

    private static final String TAG = "AppUpdate";
    private static final int TIMEOUT_MS = 20000;
    // Release files are served from GitHub (the link redirects to its file host).
    private static final List<String> HOSTS = Arrays.asList(
        "github.com",
        "objects.githubusercontent.com",
        "release-assets.githubusercontent.com");

    private final ExecutorService io = Executors.newSingleThreadExecutor();

    /** An update downloaded before is installed (or abandoned) by now. */
    @Override
    public void load() {
        io.execute(() -> {
            File apk = apkFile();
            if (apk.exists() && !apk.delete()) Log.w(TAG, "Could not remove " + apk);
        });
    }

    private File apkFile() {
        File directory = new File(getContext().getCacheDir(), "updates");
        if (!directory.isDirectory() && !directory.mkdirs()) {
            Log.w(TAG, "Could not create " + directory);
        }
        return new File(directory, "update.apk");
    }

    /** Downloads the APK at { url } (a GitHub release file). */
    @PluginMethod
    public void download(PluginCall call) {
        String url = call.getString("url", "");
        if (!isAllowed(url)) {
            call.reject("Not a GitHub release file: " + url);
            return;
        }
        io.execute(() -> {
            File target = apkFile();
            File partial = new File(target.getPath() + ".part");
            HttpURLConnection connection = null;
            try {
                connection = (HttpURLConnection) new URL(url).openConnection();
                connection.setConnectTimeout(TIMEOUT_MS);
                connection.setReadTimeout(TIMEOUT_MS);
                connection.setInstanceFollowRedirects(true);
                int status = connection.getResponseCode();
                if (!isAllowed(connection.getURL().toString())) {
                    throw new IOException("Redirected away from GitHub");
                }
                if (status != HttpURLConnection.HTTP_OK) {
                    throw new IOException("HTTP " + status);
                }
                long total = connection.getContentLengthLong();
                long received = 0;
                int lastPercent = -1;
                try (InputStream in = connection.getInputStream();
                     OutputStream out = new FileOutputStream(partial)) {
                    byte[] buffer = new byte[65536];
                    int read;
                    while ((read = in.read(buffer)) != -1) {
                        out.write(buffer, 0, read);
                        received += read;
                        if (total > 0) {
                            int percent = (int) (received * 100 / total);
                            if (percent != lastPercent) {
                                lastPercent = percent;
                                JSObject progress = new JSObject();
                                progress.put("fraction", received / (double) total);
                                notifyListeners("progress", progress);
                            }
                        }
                    }
                }
                if (target.exists() && !target.delete()) throw new IOException("Could not replace");
                if (!partial.renameTo(target)) throw new IOException("Could not save");
                JSObject result = new JSObject();
                result.put("size", target.length());
                call.resolve(result);
            } catch (IOException e) {
                Log.w(TAG, "Download failed", e);
                if (partial.exists() && !partial.delete()) partial.deleteOnExit();
                call.reject("Download failed: " + e.getMessage());
            } finally {
                if (connection != null) connection.disconnect();
            }
        });
    }

    /**
     * Opens Android's installer with the downloaded APK. Resolves
     * { needsPermission: true } if the app may not install apps yet (see
     * openInstallSettings).
     */
    @PluginMethod
    public void install(PluginCall call) {
        Context context = getContext();
        File apk = apkFile();
        if (!apk.exists()) {
            call.reject("Nothing downloaded");
            return;
        }
        JSObject result = new JSObject();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
            && !context.getPackageManager().canRequestPackageInstalls()) {
            result.put("needsPermission", true);
            call.resolve(result);
            return;
        }
        Uri uri = FileProvider.getUriForFile(
            context, context.getPackageName() + ".fileprovider", apk);
        Intent intent = new Intent(Intent.ACTION_VIEW)
            .setDataAndType(uri, "application/vnd.android.package-archive")
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
        context.startActivity(intent);
        result.put("needsPermission", false);
        call.resolve(result);
    }

    /** Opens the setting that lets this app install updates. */
    @PluginMethod
    public void openInstallSettings(PluginCall call) {
        Context context = getContext();
        Intent intent;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            intent = new Intent(
                Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                Uri.parse("package:" + context.getPackageName()));
        } else {
            intent = new Intent(Settings.ACTION_SECURITY_SETTINGS);
        }
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        context.startActivity(intent);
        call.resolve();
    }

    private static boolean isAllowed(String url) {
        try {
            Uri uri = Uri.parse(url);
            return "https".equals(uri.getScheme()) && HOSTS.contains(uri.getHost());
        } catch (Exception e) {
            return false;
        }
    }
}

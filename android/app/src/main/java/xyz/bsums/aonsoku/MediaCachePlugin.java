package xyz.bsums.aonsoku;

import android.app.DownloadManager;
import android.content.Context;
import android.net.Uri;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;

import androidx.annotation.OptIn;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.exoplayer.offline.Download;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * The song cache, for the web app (see MediaCache and
 * src/service/song-cache): its settings, the songs to keep, how much space
 * it uses, and each song's state. Also saves a file to Downloads
 * ("Save file").
 *
 * Events: "keptChanged" when a kept song's download starts, ends or fails.
 */
@OptIn(markerClass = UnstableApi.class)
@CapacitorPlugin(name = "SongCache")
public class MediaCachePlugin extends Plugin {

    private final Handler main = new Handler(Looper.getMainLooper());
    private final Runnable changed = () -> notifyListeners("keptChanged", new JSObject());

    @Override
    public void load() {
        main.post(() -> MediaCache.get(getContext()).downloads().addListener(
            new androidx.media3.exoplayer.offline.DownloadManager.Listener() {
                @Override
                public void onDownloadChanged(
                        androidx.media3.exoplayer.offline.DownloadManager manager,
                        Download download, Exception error) {
                    // At most one event a second.
                    main.removeCallbacks(changed);
                    main.postDelayed(changed, 1000);
                }

                @Override
                public void onDownloadRemoved(
                        androidx.media3.exoplayer.offline.DownloadManager manager,
                        Download download) {
                    main.removeCallbacks(changed);
                    main.postDelayed(changed, 1000);
                }
            }));
    }

    private MediaCache cache() {
        return MediaCache.get(getContext());
    }

    /** { cachePlayed, limit (bytes, 0 for no limit), wifiOnly } */
    @PluginMethod
    public void configure(PluginCall call) {
        cache().configure(
            call.getBoolean("cachePlayed", true),
            // Not getLong: it ignores a number small enough to be an int.
            call.getData().optLong("limit", MediaCache.DEFAULT_LIMIT),
            call.getBoolean("wifiOnly", false));
        call.resolve();
    }

    /**
     * { songs: [{ song, url, title }] }: every song to keep, each with its
     * Subsonic JSON (for its key) and where to download it.
     */
    @PluginMethod
    public void syncKept(PluginCall call) {
        JSONArray songs = call.getArray("songs", new JSArray());
        List<MediaCache.Wanted> wanted = new ArrayList<>();
        for (int i = 0; i < songs.length(); i++) {
            JSONObject entry = songs.optJSONObject(i);
            if (entry == null) continue;
            String key = MediaCache.keyFor(entry.optJSONObject("song"));
            String url = entry.optString("url", "");
            if (key == null || url.isEmpty()) continue;
            wanted.add(new MediaCache.Wanted(key, url, entry.optString("title", "")));
        }
        cache().syncKept(wanted);
        call.resolve();
    }

    /** { played, kept (bytes), keptSongs, keptPending, free (bytes) } */
    @PluginMethod
    public void usage(PluginCall call) {
        MediaCache.Usage usage = cache().usage();
        JSObject result = new JSObject();
        result.put("played", usage.played);
        result.put("kept", usage.kept);
        result.put("keptSongs", usage.keptSongs);
        result.put("keptPending", usage.keptPending);
        result.put("free", usage.free);
        call.resolve(result);
    }

    /** { songs: [Subsonic JSON] } → { states: { songId: state } } */
    @PluginMethod
    public void status(PluginCall call) {
        JSONArray songs = call.getArray("songs", new JSArray());
        List<String> keys = new ArrayList<>();
        List<String> ids = new ArrayList<>();
        for (int i = 0; i < songs.length(); i++) {
            JSONObject song = songs.optJSONObject(i);
            String key = MediaCache.keyFor(song);
            if (key == null) continue;
            keys.add(key);
            ids.add(song.optString("id"));
        }
        Map<String, String> states = cache().status(keys);
        JSObject byId = new JSObject();
        for (int i = 0; i < keys.size(); i++) byId.put(ids.get(i), states.get(keys.get(i)));
        JSObject result = new JSObject();
        result.put("states", byId);
        call.resolve(result);
    }

    @PluginMethod
    public void clearPlayed(PluginCall call) {
        cache().clearPlayed();
        call.resolve();
    }

    @PluginMethod
    public void clearKept(PluginCall call) {
        cache().clearKept();
        call.resolve();
    }

    /**
     * { url, fileName }: saves a file to Downloads/Aonsoku with Android's
     * download manager, which shows its progress and a notification when
     * it's done.
     */
    @PluginMethod
    public void saveFile(PluginCall call) {
        String url = call.getString("url", "");
        String fileName = call.getString("fileName", "download");
        if (url == null || url.isEmpty()) {
            call.reject("No address to save");
            return;
        }
        try {
            DownloadManager.Request request = new DownloadManager.Request(Uri.parse(url))
                .setTitle(fileName)
                .setNotificationVisibility(
                    DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                .setDestinationInExternalPublicDir(
                    Environment.DIRECTORY_DOWNLOADS, "Aonsoku/" + fileName);
            DownloadManager downloads =
                (DownloadManager) getContext().getSystemService(Context.DOWNLOAD_SERVICE);
            downloads.enqueue(request);
            call.resolve();
        } catch (RuntimeException e) {
            call.reject("Could not save " + fileName + ": " + e.getMessage());
        }
    }
}

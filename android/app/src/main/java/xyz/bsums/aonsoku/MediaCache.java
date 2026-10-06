package xyz.bsums.aonsoku;

import android.content.Context;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;

import androidx.annotation.Nullable;
import androidx.annotation.OptIn;
import androidx.media3.common.C;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.database.StandaloneDatabaseProvider;
import androidx.media3.datasource.DataSink;
import androidx.media3.datasource.DataSource;
import androidx.media3.datasource.DataSpec;
import androidx.media3.datasource.DefaultDataSource;
import androidx.media3.datasource.DefaultHttpDataSource;
import androidx.media3.datasource.cache.CacheDataSink;
import androidx.media3.datasource.cache.CacheDataSource;
import androidx.media3.datasource.cache.ContentMetadata;
import androidx.media3.datasource.cache.NoOpCacheEvictor;
import androidx.media3.datasource.cache.SimpleCache;
import androidx.media3.exoplayer.offline.Download;
import androidx.media3.exoplayer.offline.DownloadCursor;
import androidx.media3.exoplayer.offline.DownloadManager;
import androidx.media3.exoplayer.offline.DownloadRequest;
import androidx.media3.exoplayer.offline.DownloadService;
import androidx.media3.exoplayer.scheduler.Requirements;

import org.json.JSONObject;

import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Songs kept on the device, so a song plays from the device instead of
 * the server:
 *
 * - Played songs: every song the player streams is written here as it
 *   plays. The songs played longest ago are removed once it passes the size
 *   set in Settings → Caches.
 * - Kept songs: what the listener chose to "Keep cached" (an album, playlist
 *   and so on), downloaded ahead by KeptDownloadService. Never removed by
 *   size, only when the listener stops keeping it, or when the server's
 *   copy changed (see keyFor).
 *
 * The player reads kept songs first, then played songs, then the server.
 */
@OptIn(markerClass = UnstableApi.class)
final class MediaCache {

    private static final String TAG = "MediaCache";
    private static final String PREFS = "aonsoku_media_cache";
    static final long DEFAULT_LIMIT = 2L * 1024 * 1024 * 1024;
    // Kept songs download this many at a time, to spare the server.
    private static final int PARALLEL_DOWNLOADS = 2;

    private static MediaCache instance;

    private final Context app;
    private final SharedPreferences prefs;
    private final StandaloneDatabaseProvider database;
    private final ResizableLruEvictor evictor;
    final SimpleCache played;
    final SimpleCache kept;
    private final DownloadManager downloads;
    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private final Handler main = new Handler(Looper.getMainLooper());
    private volatile boolean cachePlayed;
    private boolean pausedForPlayback;

    static synchronized MediaCache get(Context context) {
        if (instance == null) instance = new MediaCache(context.getApplicationContext());
        return instance;
    }

    private MediaCache(Context app) {
        this.app = app;
        prefs = app.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        cachePlayed = prefs.getBoolean("cachePlayed", true);
        database = new StandaloneDatabaseProvider(app);
        evictor = new ResizableLruEvictor(limitBytes(prefs.getLong("limit", DEFAULT_LIMIT)));
        played = new SimpleCache(new File(app.getCacheDir(), "songs"), evictor, database);
        kept = new SimpleCache(new File(app.getFilesDir(), "kept-songs"), new NoOpCacheEvictor(), database);

        downloads = new DownloadManager(app, database, kept, http(), Runnable::run);
        downloads.setMaxParallelDownloads(PARALLEL_DOWNLOADS);
        downloads.setRequirements(requirements(prefs.getBoolean("wifiOnly", false)));
    }

    // ── Names ──

    /**
     * Where a song is kept: its ID, size and format. The address can't be
     * used, as it carries a login token that changes. When the file changes
     * on the server (a better copy, new tags), its size changes, so the old
     * copy is no longer used and a new one is cached. Same as songCacheKey
     * in the web app.
     */
    static String keyFor(String id, long size, @Nullable String suffix) {
        // The web app has ALAC in .m4a converted (src/utils/alac.ts).
        String format = "m4a".equals(suffix) ? "opus" : (suffix == null ? "" : suffix);
        return id + "." + size + "." + format;
    }

    /** The key for a song's Subsonic JSON, or null without an ID. */
    @Nullable
    static String keyFor(@Nullable JSONObject song) {
        if (song == null) return null;
        String id = song.optString("id", "");
        if (id.isEmpty()) return null;
        return keyFor(id, song.optLong("size", 0), song.optString("suffix", ""));
    }

    // ── Playback ──

    private static DefaultHttpDataSource.Factory http() {
        return new DefaultHttpDataSource.Factory().setAllowCrossProtocolRedirects(true);
    }

    /** What the player reads songs through: kept, then played, then the server. */
    DataSource.Factory playbackSource() {
        DataSource.Factory server = new DefaultDataSource.Factory(app, http());
        CacheDataSource.Factory playedSource = new CacheDataSource.Factory()
            .setCache(played)
            .setUpstreamDataSourceFactory(server)
            .setCacheWriteDataSinkFactory(this::playedSink)
            .setFlags(CacheDataSource.FLAG_IGNORE_CACHE_ON_ERROR);
        return new CacheDataSource.Factory()
            .setCache(kept)
            .setUpstreamDataSourceFactory(playedSource)
            // Only read: kept songs are written by their downloads.
            .setCacheWriteDataSinkFactory(null)
            .setFlags(CacheDataSource.FLAG_IGNORE_CACHE_ON_ERROR);
    }

    private DataSink playedSink() {
        if (cachePlayed) return new CacheDataSink(played, CacheDataSink.DEFAULT_FRAGMENT_SIZE);
        return new DiscardSink();
    }

    /**
     * Kept songs wait while the player loads a song from the server, so the
     * two don't compete for it. Called on the main thread.
     */
    void setPlaybackLoading(boolean loading) {
        if (loading == pausedForPlayback) return;
        pausedForPlayback = loading;
        if (loading) downloads.pauseDownloads();
        else downloads.resumeDownloads();
    }

    // ── Settings ──

    void configure(boolean cachePlayed, long limit, boolean wifiOnly) {
        this.cachePlayed = cachePlayed;
        prefs.edit()
            .putBoolean("cachePlayed", cachePlayed)
            .putLong("limit", limit)
            .putBoolean("wifiOnly", wifiOnly)
            .apply();
        io.execute(() -> evictor.setMaxBytes(played, limitBytes(limit)));
        Requirements requirements = requirements(wifiOnly);
        try {
            DownloadService.sendSetRequirements(
                app, KeptDownloadService.class, requirements, false);
        } catch (RuntimeException e) {
            // The app is in the background (Android won't start the service).
            main.post(() -> downloads.setRequirements(requirements));
        }
    }

    private static long limitBytes(long limit) {
        // Zero or less is "No limit".
        return limit <= 0 ? Long.MAX_VALUE : limit;
    }

    private static Requirements requirements(boolean wifiOnly) {
        return new Requirements(wifiOnly ? Requirements.NETWORK_UNMETERED : Requirements.NETWORK);
    }

    DownloadManager downloads() {
        return downloads;
    }

    // ── Kept songs ──

    /** A song to keep: its key, where to download it, and its title. */
    static final class Wanted {
        final String key;
        final String url;
        final String title;

        Wanted(String key, String url, String title) {
            this.key = key;
            this.url = url;
            this.title = title;
        }
    }

    /**
     * Makes the kept songs exactly these: downloads the missing ones (and
     * failed ones again), removes the others.
     */
    void syncKept(List<Wanted> wanted) {
        io.execute(() -> {
            Map<String, Wanted> byKey = new HashMap<>();
            for (Wanted song : wanted) byKey.put(song.key, song);
            Set<String> have = new HashSet<>();
            List<String> remove = new ArrayList<>();
            try (DownloadCursor cursor = downloads.getDownloadIndex().getDownloads()) {
                while (cursor.moveToNext()) {
                    Download download = cursor.getDownload();
                    String key = download.request.id;
                    if (!byKey.containsKey(key)) remove.add(key);
                    else if (download.state != Download.STATE_FAILED) have.add(key);
                }
            } catch (IOException e) {
                Log.w(TAG, "Could not read the kept songs", e);
                return;
            }
            for (String key : remove) send(() -> DownloadService.sendRemoveDownload(
                app, KeptDownloadService.class, key, false), () -> downloads.removeDownload(key));
            for (Wanted song : wanted) {
                if (have.contains(song.key)) continue;
                DownloadRequest request = new DownloadRequest.Builder(song.key, Uri.parse(song.url))
                    .setCustomCacheKey(song.key)
                    .setData(song.title.getBytes(StandardCharsets.UTF_8))
                    .build();
                send(() -> DownloadService.sendAddDownload(
                    app, KeptDownloadService.class, request, false),
                    () -> downloads.addDownload(request));
            }
            Log.i(TAG, "Kept: " + wanted.size() + " wanted, "
                + have.size() + " already there, " + remove.size() + " removed");
        });
    }

    /**
     * Through the download service, which keeps going in the background;
     * if Android won't start it (the app is in the background), straight to
     * the download manager, which runs while the app does.
     */
    private void send(Runnable viaService, Runnable direct) {
        try {
            viaService.run();
        } catch (RuntimeException e) {
            main.post(direct);
        }
    }

    // ── Questions from the web app ──

    static final class Usage {
        long played;
        long kept;
        int keptSongs;
        int keptPending;
        long free;
    }

    Usage usage() {
        Usage usage = new Usage();
        usage.played = played.getCacheSpace();
        usage.kept = kept.getCacheSpace();
        try (DownloadCursor cursor = downloads.getDownloadIndex().getDownloads()) {
            while (cursor.moveToNext()) {
                if (cursor.getDownload().state == Download.STATE_COMPLETED) usage.keptSongs++;
                else usage.keptPending++;
            }
        } catch (IOException e) {
            Log.w(TAG, "Could not count the kept songs", e);
        }
        usage.free = app.getFilesDir().getUsableSpace();
        return usage;
    }

    /**
     * Each key's state: "kept", "downloading", "queued", "waiting" (for the
     * network the settings allow), "failed", "cached" (a played song, all of
     * it) or "none".
     */
    Map<String, String> status(List<String> keys) {
        Map<String, String> result = new HashMap<>();
        boolean waiting = downloads.getNotMetRequirements() != 0;
        for (String key : keys) {
            String state = "none";
            try {
                Download download = downloads.getDownloadIndex().getDownload(key);
                if (download != null) state = stateOf(download, waiting);
            } catch (IOException e) {
                Log.w(TAG, "Could not read " + key, e);
            }
            if (state.equals("none") && isComplete(played, key)) state = "cached";
            result.put(key, state);
        }
        return result;
    }

    private static String stateOf(Download download, boolean waiting) {
        switch (download.state) {
            case Download.STATE_COMPLETED:
                return "kept";
            case Download.STATE_DOWNLOADING:
                return "downloading";
            case Download.STATE_FAILED:
                return "failed";
            default:
                return waiting ? "waiting" : "queued";
        }
    }

    private static boolean isComplete(SimpleCache cache, String key) {
        long length = ContentMetadata.getContentLength(cache.getContentMetadata(key));
        return length != C.LENGTH_UNSET && cache.isCached(key, 0, length);
    }

    void clearPlayed() {
        io.execute(() -> {
            for (String key : new ArrayList<>(played.getKeys())) played.removeResource(key);
        });
    }

    void clearKept() {
        send(() -> DownloadService.sendRemoveAllDownloads(app, KeptDownloadService.class, false),
            downloads::removeAllDownloads);
    }

    /** A sink for when "Cache songs I play" is off: nothing is written. */
    private static final class DiscardSink implements DataSink {
        @Override
        public void open(DataSpec dataSpec) {}

        @Override
        public void write(byte[] buffer, int offset, int length) {}

        @Override
        public void close() {}
    }
}

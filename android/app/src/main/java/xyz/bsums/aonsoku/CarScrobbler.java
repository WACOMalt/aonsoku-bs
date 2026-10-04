package xyz.bsums.aonsoku;

import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.util.Log;

import androidx.annotation.Nullable;
import androidx.media3.common.MediaItem;
import androidx.media3.common.Player;

import java.io.IOException;
import java.util.concurrent.ExecutorService;

/**
 * Reports what a car queue plays to the server ("now playing", then a
 * scrobble once half the song, or four minutes, has played), as the web app
 * does for its own queue. Only while the car queue is not adopted: after
 * that the web app reports.
 */
final class CarScrobbler implements Player.Listener {

    private static final String TAG = "NativePlayer";
    private static final long CHECK_MS = 5000;
    private static final long MAX_NEEDED_MS = 4 * 60 * 1000;

    private final Context context;
    private final Player player;
    private final ExecutorService network;
    private final Handler main = new Handler(Looper.getMainLooper());

    @Nullable private String songId;
    private long durationMs;
    private long playedMs;
    private long playingSince = -1;
    private boolean scrobbled;

    private final Runnable check = new Runnable() {
        @Override
        public void run() {
            maybeScrobble();
            if (playingSince >= 0) main.postDelayed(this, CHECK_MS);
        }
    };

    CarScrobbler(Context context, Player player, ExecutorService network) {
        this.context = context.getApplicationContext();
        this.player = player;
        this.network = network;
        player.addListener(this);
    }

    void release() {
        player.removeListener(this);
        main.removeCallbacks(check);
    }

    @Override
    public void onMediaItemTransition(@Nullable MediaItem item, int reason) {
        pauseClock();
        songId = null;
        if (item == null || !PlaybackEngine.isCarQueue()) return;
        songId = CarLibrary.songIdOf(item);
        if (songId == null) return;
        Long duration = item.mediaMetadata.durationMs;
        durationMs = duration != null ? duration : 0;
        playedMs = 0;
        scrobbled = false;
        send(songId, false);
        if (player.isPlaying()) startClock();
    }

    @Override
    public void onIsPlayingChanged(boolean isPlaying) {
        if (isPlaying && songId != null && PlaybackEngine.isCarQueue()) {
            startClock();
        } else {
            pauseClock();
        }
    }

    private void startClock() {
        if (playingSince >= 0) return;
        playingSince = SystemClock.elapsedRealtime();
        main.removeCallbacks(check);
        main.postDelayed(check, CHECK_MS);
    }

    private void pauseClock() {
        if (playingSince >= 0) {
            playedMs += SystemClock.elapsedRealtime() - playingSince;
            playingSince = -1;
        }
        main.removeCallbacks(check);
        maybeScrobble();
    }

    private void maybeScrobble() {
        if (scrobbled || songId == null || !PlaybackEngine.isCarQueue()) return;
        long played = playedMs
            + (playingSince >= 0 ? SystemClock.elapsedRealtime() - playingSince : 0);
        long needed = durationMs > 0 ? Math.min(durationMs / 2, MAX_NEEDED_MS) : MAX_NEEDED_MS;
        if (played < needed) return;
        scrobbled = true;
        send(songId, true);
    }

    private void send(String id, boolean submission) {
        long time = System.currentTimeMillis();
        network.execute(() -> {
            AonsokuServer server = AonsokuServer.load(context);
            if (server == null) return;
            try {
                server.call("scrobble", AonsokuServer.map(
                    "id", id,
                    "submission", String.valueOf(submission),
                    "time", String.valueOf(time)));
                DebugLog.i(TAG, (submission ? "scrobbled " : "now playing ") + id);
            } catch (IOException e) {
                Log.w(TAG, "Scrobble failed", e);
            }
        });
    }
}

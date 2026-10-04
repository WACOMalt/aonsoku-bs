package xyz.bsums.aonsoku;

import android.content.Context;
import android.os.Handler;
import android.os.Looper;

import androidx.annotation.OptIn;
import androidx.media3.common.AudioAttributes;
import androidx.media3.common.C;
import androidx.media3.common.Player;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.datasource.DefaultDataSource;
import androidx.media3.datasource.DefaultHttpDataSource;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory;

/**
 * The one ExoPlayer that plays songs, shared by the NativePlayer plugin (which
 * the web app drives) and PlaybackService (which exposes it to the system:
 * notification, lock screen, headsets, cars).
 *
 * ExoPlayer plays a playlist through a single audio output and trims each
 * track's encoder padding, so consecutive tracks join sample-accurately:
 * albums that run continuously play without a gap. Only touch it on the main
 * thread.
 */
final class PlaybackEngine {

    private static final String TAG = "NativePlayer";

    /** Next/previous pressed on the notification, lock screen or a headset. */
    interface CommandListener {
        void onCommand(String action);
    }

    /** A list started from the car (see PlaybackService.QueuePlayer). */
    interface CarQueueListener {
        void onCarQueue();
    }

    private static final Handler MAIN = new Handler(Looper.getMainLooper());

    private static ExoPlayer player;
    private static CommandListener commandListener;
    private static CarQueueListener carQueueListener;
    // Whether the player holds a list started from the car, which the web
    // app has not taken over yet: it holds all of it, not a window of the
    // web app's queue.
    private static boolean carQueue;

    private PlaybackEngine() {}

    @OptIn(markerClass = UnstableApi.class)
    static ExoPlayer get(Context context) {
        if (player == null) {
            Context app = context.getApplicationContext();
            DefaultHttpDataSource.Factory http = new DefaultHttpDataSource.Factory()
                .setAllowCrossProtocolRedirects(true);
            player = new ExoPlayer.Builder(app)
                .setMediaSourceFactory(
                    new DefaultMediaSourceFactory(new DefaultDataSource.Factory(app, http)))
                .setAudioAttributes(
                    new AudioAttributes.Builder()
                        .setUsage(C.USAGE_MEDIA)
                        .setContentType(C.AUDIO_CONTENT_TYPE_MUSIC)
                        .build(),
                    true)
                // Pause when headphones are unplugged, like other players.
                .setHandleAudioBecomingNoisy(true)
                // Streaming with the screen off needs the CPU and Wi-Fi awake.
                .setWakeMode(C.WAKE_MODE_NETWORK)
                .build();
        }
        return player;
    }

    static ExoPlayer peek() {
        return player;
    }

    static void release() {
        if (player != null) {
            player.release();
            player = null;
        }
    }

    static void setCommandListener(CommandListener listener) {
        commandListener = listener;
    }

    static void setCarQueueListener(CarQueueListener listener) {
        carQueueListener = listener;
    }

    static boolean isCarQueue() {
        return carQueue;
    }

    /**
     * The car is starting a list; tells the web app, if it runs, to adopt it
     * once the player has it.
     */
    static void startCarQueue() {
        DebugLog.i(TAG, "car queue started");
        carQueue = true;
        CarQueueListener listener = carQueueListener;
        if (listener != null) MAIN.post(listener::onCarQueue);
    }

    /** The web app took the player over: its queue again, not the car's. */
    static void endCarQueue() {
        carQueue = false;
    }

    static void sendCommand(String action) {
        CommandListener listener = commandListener;
        if (listener != null) listener.onCommand(action);
    }

    /**
     * Next from the notification, lock screen or a headset. Handled here when
     * the next track is loaded, so it works even while the web app is asleep
     * in the background; the web app follows when it is told of the change.
     */
    static void skipToNext(Player player) {
        DebugLog.i(TAG, "next pressed");
        int index = player.getCurrentMediaItemIndex();
        if (index + 1 < player.getMediaItemCount()) {
            player.seekTo(index + 1, 0);
            if (player.getPlaybackState() == Player.STATE_IDLE) player.prepare();
        } else if (!carQueue) {
            // A car queue is held whole: past its end there is nothing.
            sendCommand("nexttrack");
        }
    }

    /** Previous, handled the same way as next. */
    static void skipToPrevious(Player player) {
        DebugLog.i(TAG, "previous pressed");
        int index = player.getCurrentMediaItemIndex();
        if (index >= 1) {
            player.seekTo(index - 1, 0);
            if (player.getPlaybackState() == Player.STATE_IDLE) player.prepare();
        } else if (!carQueue) {
            sendCommand("previoustrack");
        } else {
            player.seekTo(0);
        }
    }
}

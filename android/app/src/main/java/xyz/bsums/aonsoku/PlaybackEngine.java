package xyz.bsums.aonsoku;

import android.content.Context;
import android.content.SharedPreferences;
import android.os.Handler;
import android.os.Looper;

import androidx.annotation.OptIn;
import androidx.media3.common.AudioAttributes;
import androidx.media3.common.C;
import androidx.media3.common.MediaItem;
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

    /**
     * Shuffle, repeat and the current song's favourite as the web app has
     * them, for the buttons in the car and the notification (see
     * PlaybackService). Not used for a car queue, which the player itself
     * shuffles and repeats.
     */
    static final class Modes {
        final boolean shuffle;
        /** Player.REPEAT_MODE_OFF, _ONE or _ALL. */
        final int repeat;
        final boolean starred;

        Modes(boolean shuffle, int repeat, boolean starred) {
            this.shuffle = shuffle;
            this.repeat = repeat;
            this.starred = starred;
        }
    }

    /** An item's linear ReplayGain factor, in its metadata extras. */
    static final String EXTRA_GAIN = "aonsoku.gain";

    private static final Handler MAIN = new Handler(Looper.getMainLooper());
    private static final String PREFS = "aonsoku_player";
    // The listener's volume (0..1), kept for playback without the web app.
    private static float volume = 1f;
    private static SharedPreferences prefs;
    private static Modes webModes = new Modes(false, Player.REPEAT_MODE_OFF, false);
    private static Runnable modesListener;

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
            prefs = app.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
            volume = prefs.getFloat("volume", 1f);
            // Each song plays at the listener's volume times its ReplayGain.
            player.addListener(new Player.Listener() {
                @Override
                public void onMediaItemTransition(MediaItem item, int reason) {
                    applyVolume();
                }
            });
        }
        return player;
    }

    /** Sets the listener's volume (0..1), and remembers it. */
    static void setVolume(float value) {
        volume = Math.max(0f, Math.min(1f, value));
        if (prefs != null) prefs.edit().putFloat("volume", volume).apply();
        applyVolume();
    }

    /** The listener's volume times the current song's ReplayGain. */
    static void applyVolume() {
        if (player == null) return;
        float gain = 1f;
        MediaItem item = player.getCurrentMediaItem();
        if (item != null && item.mediaMetadata.extras != null) {
            gain = item.mediaMetadata.extras.getFloat(EXTRA_GAIN, 1f);
        }
        // The output cannot be boosted above full scale.
        player.setVolume(Math.max(0f, Math.min(1f, volume * gain)));
        DebugLog.i(TAG, "volume " + volume + " x gain " + gain);
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

    // Controllers from other apps (Android Auto, the system's media
    // controls), connected to PlaybackService.
    private static int externalControllers;

    static void externalControllerConnected() {
        externalControllers++;
    }

    static void externalControllerDisconnected() {
        externalControllers = Math.max(0, externalControllers - 1);
    }

    static boolean hasExternalControllers() {
        return externalControllers > 0;
    }

    /**
     * A shuffled order with the current song first and the rest random, as
     * the app shuffles (ExoPlayer's own order can put it anywhere).
     */
    @OptIn(markerClass = UnstableApi.class)
    static void shuffleFromCurrent(ExoPlayer player) {
        if (player == null) return;
        int count = player.getMediaItemCount();
        int current = player.getCurrentMediaItemIndex();
        if (count == 0 || current < 0 || current >= count) return;
        java.util.List<Integer> rest = new java.util.ArrayList<>();
        for (int i = 0; i < count; i++) if (i != current) rest.add(i);
        java.util.Collections.shuffle(rest);
        int[] order = new int[count];
        order[0] = current;
        for (int i = 0; i < rest.size(); i++) order[i + 1] = rest.get(i);
        player.setShuffleOrder(
            new androidx.media3.exoplayer.source.ShuffleOrder.DefaultShuffleOrder(
                order, System.nanoTime()));
    }

    /** Whether the web app is running to take commands. */
    static boolean hasWebApp() {
        return commandListener != null;
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
        modesChanged();
        CarQueueListener listener = carQueueListener;
        if (listener != null) MAIN.post(listener::onCarQueue);
    }

    /** The web app took the player over: its queue again, not the car's. */
    static void endCarQueue() {
        if (!carQueue) return;
        carQueue = false;
        modesChanged();
    }

    static Modes webModes() {
        return webModes;
    }

    static void setWebModes(Modes modes) {
        webModes = modes;
        modesChanged();
    }

    /** Told (on the main thread) when the buttons' state may have changed. */
    static void setModesListener(Runnable listener) {
        modesListener = listener;
    }

    static void modesChanged() {
        Runnable listener = modesListener;
        if (listener != null) MAIN.post(listener);
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
        // In order, or shuffled and repeating for a car queue.
        int next = player.getNextMediaItemIndex();
        if (next != C.INDEX_UNSET) {
            player.seekTo(next, 0);
            if (player.getPlaybackState() == Player.STATE_IDLE) player.prepare();
        } else if (!carQueue) {
            // A car queue is held whole: past its end there is nothing.
            sendCommand("nexttrack");
        }
    }

    /** Previous, handled the same way as next. */
    static void skipToPrevious(Player player) {
        DebugLog.i(TAG, "previous pressed");
        int previous = player.getPreviousMediaItemIndex();
        if (previous != C.INDEX_UNSET) {
            player.seekTo(previous, 0);
            if (player.getPlaybackState() == Player.STATE_IDLE) player.prepare();
        } else if (!carQueue) {
            sendCommand("previoustrack");
        } else {
            player.seekTo(0);
        }
    }
}

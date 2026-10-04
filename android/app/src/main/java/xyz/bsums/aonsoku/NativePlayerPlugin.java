package xyz.bsums.aonsoku;

import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.media3.common.C;
import androidx.media3.common.MediaItem;
import androidx.media3.common.MediaMetadata;
import androidx.media3.common.PlaybackException;
import androidx.media3.common.Player;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.session.MediaController;
import androidx.media3.session.SessionToken;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.common.util.concurrent.ListenableFuture;

import java.util.ArrayList;
import java.util.List;

/**
 * Lets the web app play songs through ExoPlayer (see PlaybackEngine).
 *
 * The web app keeps the queue. The player holds the current track, the one
 * before it and a stretch of the queue after it: it preloads the next and
 * joins onto it without a gap, the notification and headset buttons can
 * move without waiting for the web app, and if the web app stalls in the
 * background, playback goes on through what is held. Whenever the player
 * moves, the web app is told, moves its queue to match and brings the held
 * tracks up to date. Every item carries a key from
 * the web app so events can be matched to the item they are about.
 *
 * Events: "progress" (position), "transition" (a new item started),
 * "playing" (play/pause from outside the app: notification, headset, another
 * app taking audio focus), "ended" (nothing left to play), "error",
 * "command" (next/previous from the notification or a headset) and
 * "carQueue" (Android Auto started a list, for the web app to adopt; see
 * getCarQueue).
 */
@CapacitorPlugin(name = "NativePlayer")
public class NativePlayerPlugin extends Plugin {

    private static final String TAG = "NativePlayer";
    private static final long PROGRESS_INTERVAL_MS = 500;
    private static final String EXTRA_GAIN = "aonsoku.gain";

    private final Handler main = new Handler(Looper.getMainLooper());

    private ExoPlayer player;
    private ListenableFuture<MediaController> controller;
    private float volume = 1f;
    // What the web app last asked for; changes from anywhere else are
    // reported back so its play/pause state follows.
    private boolean requestedPlaying = false;

    private final Runnable progressTick = new Runnable() {
        @Override
        public void run() {
            emitProgress();
            if (player != null && player.isPlaying()) {
                main.postDelayed(this, PROGRESS_INTERVAL_MS);
            }
        }
    };

    private final Player.Listener listener = new Player.Listener() {
        @Override
        public void onMediaItemTransition(@Nullable MediaItem item, int reason) {
            if (item == null) return;
            DebugLog.i(TAG, "transition to " + item.mediaId + " reason " + reason);
            applyVolume();
            JSObject data = new JSObject();
            data.put("key", item.mediaId);
            data.put("reason", reason);
            notifyListeners("transition", data);
            // Keep one item before the current one, for previous. A car
            // queue is held whole until the web app adopts it.
            main.post(() -> {
                if (player == null || PlaybackEngine.isCarQueue()) return;
                int index = player.getCurrentMediaItemIndex();
                if (index > 1) player.removeMediaItems(0, index - 1);
            });
            emitProgress();
        }

        @Override
        public void onPlayWhenReadyChanged(boolean playWhenReady, int reason) {
            updateAwake();
            DebugLog.i(TAG, "playWhenReady " + playWhenReady + " reason " + reason
                + (playWhenReady == requestedPlaying ? " (requested)" : " (from outside)"));
            if (playWhenReady == requestedPlaying) return;
            requestedPlaying = playWhenReady;
            JSObject data = new JSObject();
            data.put("playing", playWhenReady);
            data.put("reason", reason);
            notifyListeners("playing", data);
        }

        @Override
        public void onIsPlayingChanged(boolean isPlaying) {
            updateAwake();
            main.removeCallbacks(progressTick);
            if (isPlaying) {
                main.post(progressTick);
            } else {
                emitProgress();
            }
        }

        @Override
        public void onPlaybackStateChanged(int state) {
            updateAwake();
            emitProgress();
            if (state == Player.STATE_ENDED) {
                JSObject data = new JSObject();
                data.put("key", currentKey());
                notifyListeners("ended", data);
            }
        }

        @Override
        public void onPositionDiscontinuity(
            @NonNull Player.PositionInfo oldPosition,
            @NonNull Player.PositionInfo newPosition,
            int reason
        ) {
            emitProgress();
        }

        @Override
        public void onPlayerError(@NonNull PlaybackException error) {
            Log.e(TAG, "Playback error", error);
            JSObject data = new JSObject();
            data.put("key", currentKey());
            data.put("code", error.getErrorCodeName());
            data.put("message", error.getMessage());
            notifyListeners("error", data);
        }
    };

    @Override
    public void load() {
        PlaybackEngine.setCommandListener(action -> {
            DebugLog.i(TAG, "command to the web app: " + action);
            JSObject data = new JSObject();
            data.put("action", action);
            notifyListeners("command", data);
        });
        PlaybackEngine.setCarQueueListener(() -> {
            JSObject queue = carQueueData();
            if (queue != null) notifyListeners("carQueue", queue);
        });
    }

    @Override
    protected void handleOnDestroy() {
        main.post(() -> {
            main.removeCallbacks(progressTick);
            if (player != null) {
                player.removeListener(listener);
                player.stop();
                player.clearMediaItems();
                player = null;
            }
            closeSession();
        });
        PlaybackEngine.setCommandListener(null);
        PlaybackEngine.setCarQueueListener(null);
        super.handleOnDestroy();
    }

    /**
     * Starts a track: { previous?, current, upcoming[], positionMs,
     * playWhenReady, repeatOne, volume }. Items are { key, url, title, artist, album,
     * artworkUrl, durationMs, gain }.
     */
    @PluginMethod
    public void load(PluginCall call) {
        JSObject current = call.getObject("current");
        if (current == null) {
            call.reject("current is required");
            return;
        }
        JSObject previous = call.getObject("previous");
        List<JSObject> upcoming = objects(call, "upcoming");
        long positionMs = Math.max(0, call.getDouble("positionMs", 0.0).longValue());
        boolean playWhenReady = Boolean.TRUE.equals(call.getBoolean("playWhenReady", false));
        boolean repeatOne = Boolean.TRUE.equals(call.getBoolean("repeatOne", false));
        float newVolume = call.getFloat("volume", volume);

        main.post(() -> {
            DebugLog.i(TAG, "load " + current.getString("key") + " at " + positionMs
                + (playWhenReady ? " playing" : " paused"));
            ExoPlayer p = ensurePlayer();
            PlaybackEngine.endCarQueue();
            List<MediaItem> items = new ArrayList<>();
            if (previous != null) items.add(toMediaItem(previous));
            items.add(toMediaItem(current));
            for (JSObject item : upcoming) items.add(toMediaItem(item));
            volume = newVolume;
            requestedPlaying = playWhenReady;
            p.setRepeatMode(repeatOne ? Player.REPEAT_MODE_ONE : Player.REPEAT_MODE_OFF);
            p.setMediaItems(items, previous != null ? 1 : 0, positionMs);
            applyVolume();
            p.prepare();
            p.setPlayWhenReady(playWhenReady);
            call.resolve();
        });
    }

    /**
     * Sets the tracks around the current one: { previous?, upcoming[] }.
     * Tracks already held in the same order (by key) are left alone, so a
     * preloaded next track keeps its buffered audio.
     */
    @PluginMethod
    public void setAdjacent(PluginCall call) {
        JSObject previous = call.getObject("previous");
        List<JSObject> upcoming = objects(call, "upcoming");
        main.post(() -> {
            if (player == null || player.getMediaItemCount() == 0) {
                call.resolve();
                return;
            }
            int index = player.getCurrentMediaItemIndex();
            int count = player.getMediaItemCount();
            int kept = 0;
            while (kept < upcoming.size() && index + 1 + kept < count
                && player.getMediaItemAt(index + 1 + kept).mediaId
                    .equals(upcoming.get(kept).getString("key"))) {
                kept++;
            }
            if (count > index + 1 + kept) player.removeMediaItems(index + 1 + kept, count);
            List<MediaItem> added = new ArrayList<>();
            for (int i = kept; i < upcoming.size(); i++) added.add(toMediaItem(upcoming.get(i)));
            if (!added.isEmpty()) player.addMediaItems(added);

            index = player.getCurrentMediaItemIndex();
            if (previous != null && index >= 1
                && player.getMediaItemAt(index - 1).mediaId.equals(previous.getString("key"))) {
                if (index > 1) player.removeMediaItems(0, index - 1);
            } else {
                if (index > 0) player.removeMediaItems(0, index);
                if (previous != null) player.addMediaItem(0, toMediaItem(previous));
            }
            call.resolve();
        });
    }

    /**
     * Moves to the item next to the current one with this key: { key }. Does
     * nothing if it is already playing, or is not next to it.
     */
    @PluginMethod
    public void skipTo(PluginCall call) {
        String key = call.getString("key", "");
        main.post(() -> {
            JSObject result = new JSObject();
            boolean skipped = false;
            if (player != null) {
                int index = player.getCurrentMediaItemIndex();
                if (key.equals(currentKey())) {
                    skipped = true;
                } else {
                    for (int target : new int[] { index + 1, index - 1 }) {
                        if (target >= 0 && target < player.getMediaItemCount()
                            && player.getMediaItemAt(target).mediaId.equals(key)) {
                            player.seekTo(target, 0);
                            if (player.getPlaybackState() == Player.STATE_IDLE) player.prepare();
                            skipped = true;
                            break;
                        }
                    }
                }
            }
            DebugLog.i(TAG, "skip to " + key + (skipped ? "" : " missed"));
            result.put("skipped", skipped);
            call.resolve(result);
        });
    }

    @PluginMethod
    public void setPlaying(PluginCall call) {
        boolean playing = Boolean.TRUE.equals(call.getBoolean("playing", false));
        main.post(() -> {
            DebugLog.i(TAG, "setPlaying " + playing);
            requestedPlaying = playing;
            if (player != null) {
                if (playing && player.getPlaybackState() == Player.STATE_IDLE
                    && player.getMediaItemCount() > 0) {
                    player.prepare();
                }
                player.setPlayWhenReady(playing);
            }
            call.resolve();
        });
    }

    @PluginMethod
    public void seekTo(PluginCall call) {
        long positionMs = Math.max(0, call.getDouble("positionMs", 0.0).longValue());
        main.post(() -> {
            if (player != null && player.getMediaItemCount() > 0) player.seekTo(positionMs);
            call.resolve();
        });
    }

    @PluginMethod
    public void setVolume(PluginCall call) {
        float newVolume = call.getFloat("volume", 1f);
        main.post(() -> {
            volume = newVolume;
            applyVolume();
            call.resolve();
        });
    }

    @PluginMethod
    public void setRepeatOne(PluginCall call) {
        boolean enabled = Boolean.TRUE.equals(call.getBoolean("enabled", false));
        main.post(() -> {
            if (player != null) {
                player.setRepeatMode(enabled ? Player.REPEAT_MODE_ONE : Player.REPEAT_MODE_OFF);
            }
            call.resolve();
        });
    }

    /**
     * Stops and empties the player and closes its media session, so the
     * system sends media buttons to whatever plays instead (the WebView
     * player, for radio or a Connect remote) rather than to an idle session.
     */
    @PluginMethod
    public void stop(PluginCall call) {
        main.post(() -> {
            DebugLog.i(TAG, "stop");
            requestedPlaying = false;
            PlaybackEngine.endCarQueue();
            main.removeCallbacks(progressTick);
            if (player != null) {
                player.stop();
                player.clearMediaItems();
            }
            closeSession();
            AonsokuWebView.setAwake("native", false);
            call.resolve();
        });
    }

    /**
     * Keeps the page running in the background (see AonsokuWebView) for the
     * web app's own reasons: { enabled }, e.g. while it plays radio or is in
     * a Jam.
     */
    @PluginMethod
    public void setKeepAwake(PluginCall call) {
        AonsokuWebView.setAwake("page", Boolean.TRUE.equals(call.getBoolean("enabled", false)));
        call.resolve();
    }

    /**
     * The server the web app is signed in to, for Android Auto to browse
     * while the app is closed: { url, username, password, authType,
     * protocolVersion }, the password as the web app keeps it (a token or
     * encoded). Without a url, forgets it (signed out).
     */
    @PluginMethod
    public void setServer(PluginCall call) {
        String url = call.getString("url", "");
        String username = call.getString("username", "");
        String password = call.getString("password", "");
        if (url == null || url.isEmpty() || username == null || username.isEmpty()
            || password == null || password.isEmpty()) {
            if (AonsokuServer.load(getContext()) != null) AonsokuServer.clear(getContext());
        } else {
            AonsokuServer.save(
                getContext(), url, username, password,
                call.getString("authType", "token"),
                call.getString("protocolVersion", "1.16.0"));
        }
        call.resolve();
    }

    /**
     * The list Android Auto started, if the player holds one the web app has
     * not adopted: { songs (Subsonic JSON), index, key, positionMs, playing },
     * or { songs: null }.
     */
    @PluginMethod
    public void getCarQueue(PluginCall call) {
        main.post(() -> {
            JSObject queue = carQueueData();
            if (queue == null) {
                queue = new JSObject();
                queue.put("songs", null);
            }
            call.resolve(queue);
        });
    }

    /**
     * The web app now holds the car's list as its queue: from here the
     * player holds its window of it again (see setAdjacent), and the current
     * item, which keeps playing, is reported under the car's key.
     */
    @PluginMethod
    public void adoptCarQueue(PluginCall call) {
        main.post(() -> {
            DebugLog.i(TAG, "car queue adopted");
            ExoPlayer p = ensurePlayer();
            PlaybackEngine.endCarQueue();
            requestedPlaying = p.getPlayWhenReady();
            updateAwake();
            emitProgress();
            if (p.isPlaying()) {
                main.removeCallbacks(progressTick);
                main.post(progressTick);
            }
            call.resolve();
        });
    }

    @PluginMethod
    public void getState(PluginCall call) {
        main.post(() -> call.resolve(progressData()));
    }

    private ExoPlayer ensurePlayer() {
        if (player == null) {
            player = PlaybackEngine.get(getContext());
            player.addListener(listener);
        }
        // Connecting a controller starts PlaybackService, which puts the
        // player in the notification and keeps it running in the background.
        if (controller == null) {
            Context context = getContext();
            SessionToken token = new SessionToken(
                context, new ComponentName(context, PlaybackService.class));
            controller = new MediaController.Builder(context, token).buildAsync();
        }
        return player;
    }

    /** Disconnects from PlaybackService and stops it, ending its session. */
    private void closeSession() {
        if (controller == null) return;
        MediaController.releaseFuture(controller);
        controller = null;
        Context context = getContext();
        context.stopService(new Intent(context, PlaybackService.class));
    }

    /** The objects in an array argument (missing or malformed: none). */
    private static List<JSObject> objects(PluginCall call, String name) {
        List<JSObject> result = new ArrayList<>();
        JSArray array = call.getArray(name);
        if (array == null) return result;
        for (int i = 0; i < array.length(); i++) {
            try {
                result.add(JSObject.fromJSONObject(array.getJSONObject(i)));
            } catch (org.json.JSONException e) {
                Log.w(TAG, "Skipping a malformed " + name + " item", e);
            }
        }
        return result;
    }

    private MediaItem toMediaItem(JSObject item) {
        Bundle extras = new Bundle();
        extras.putFloat(EXTRA_GAIN, (float) item.optDouble("gain", 1.0));

        MediaMetadata.Builder metadata = new MediaMetadata.Builder()
            .setTitle(item.getString("title", ""))
            .setArtist(item.getString("artist", ""))
            .setAlbumTitle(item.getString("album", ""))
            .setExtras(extras);
        String artwork = item.getString("artworkUrl", "");
        if (artwork != null && !artwork.isEmpty()) metadata.setArtworkUri(Uri.parse(artwork));
        long durationMs = (long) item.optDouble("durationMs", 0);
        if (durationMs > 0) metadata.setDurationMs(durationMs);

        return new MediaItem.Builder()
            .setMediaId(item.getString("key", ""))
            .setUri(item.getString("url", ""))
            .setMediaMetadata(metadata.build())
            .build();
    }

    /** The listener's volume times the current track's ReplayGain. */
    private void applyVolume() {
        if (player == null) return;
        float gain = 1f;
        MediaItem item = player.getCurrentMediaItem();
        if (item != null && item.mediaMetadata.extras != null) {
            gain = item.mediaMetadata.extras.getFloat(EXTRA_GAIN, 1f);
        }
        // The output cannot be boosted above full scale.
        player.setVolume(Math.max(0f, Math.min(1f, volume * gain)));
    }

    /**
     * While the native player plays (or is about to), keep the page running
     * so the queue, Jam and Connect keep up, including when play was pressed
     * on the notification while the page was asleep.
     */
    private void updateAwake() {
        boolean playing = player != null
            && player.getPlayWhenReady()
            && player.getMediaItemCount() > 0
            && player.getPlaybackState() != Player.STATE_IDLE
            && player.getPlaybackState() != Player.STATE_ENDED;
        AonsokuWebView.setAwake("native", playing);
    }

    private String currentKey() {
        if (player == null) return "";
        MediaItem item = player.getCurrentMediaItem();
        return item == null ? "" : item.mediaId;
    }

    /** The car queue the player holds, or null (see getCarQueue). */
    @Nullable
    private JSObject carQueueData() {
        ExoPlayer p = PlaybackEngine.peek();
        if (p == null || !PlaybackEngine.isCarQueue() || p.getMediaItemCount() == 0) return null;
        JSArray songs = new JSArray();
        int index = 0;
        int current = p.getCurrentMediaItemIndex();
        for (int i = 0; i < p.getMediaItemCount(); i++) {
            MediaItem item = p.getMediaItemAt(i);
            Bundle extras = item.mediaMetadata.extras;
            String song = extras != null ? extras.getString(CarLibrary.EXTRA_SONG) : null;
            if (song == null) continue;
            try {
                if (i == current) index = songs.length();
                songs.put(new org.json.JSONObject(song));
            } catch (org.json.JSONException e) {
                Log.w(TAG, "Skipping a malformed car queue item", e);
            }
        }
        if (songs.length() == 0) return null;
        MediaItem currentItem = p.getCurrentMediaItem();
        JSObject data = new JSObject();
        data.put("songs", songs);
        data.put("index", index);
        data.put("key", currentItem != null ? currentItem.mediaId : "");
        data.put("positionMs", p.getCurrentPosition());
        data.put("playing", p.getPlayWhenReady());
        return data;
    }

    private JSObject progressData() {
        JSObject data = new JSObject();
        data.put("key", currentKey());
        if (player == null) {
            data.put("positionMs", 0);
            data.put("durationMs", -1);
            data.put("playing", false);
            data.put("state", Player.STATE_IDLE);
            return data;
        }
        long duration = player.getDuration();
        data.put("positionMs", player.getCurrentPosition());
        data.put("durationMs", duration == C.TIME_UNSET ? -1 : duration);
        data.put("playing", player.isPlaying());
        data.put("state", player.getPlaybackState());
        return data;
    }

    private void emitProgress() {
        if (player == null) return;
        notifyListeners("progress", progressData());
    }
}

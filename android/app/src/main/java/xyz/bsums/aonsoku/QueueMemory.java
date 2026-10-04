package xyz.bsums.aonsoku;

import android.content.Context;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;

import androidx.annotation.Nullable;
import androidx.media3.common.C;
import androidx.media3.common.MediaItem;
import androidx.media3.common.Player;
import androidx.media3.common.Timeline;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutorService;

/**
 * Remembers what the player holds (songs, the one playing, where in it, and
 * whether it was shuffled or repeating), so a car, a headset's play button
 * or the system's media controls can resume it after the app has gone (see
 * PlaybackService.onPlaybackResumption). The songs are the ones the player
 * holds: a car's list whole, or the stretch of the web app's queue around
 * the current song.
 */
final class QueueMemory implements Player.Listener {

    private static final String TAG = "NativePlayer";
    private static final String FILE = "last_queue.json";
    // Saves are put off this long, so a burst of changes writes once.
    private static final long SAVE_DELAY_MS = 2000;

    /** A remembered queue: its songs (Subsonic JSON) in playing order. */
    static final class Saved {
        final List<JSONObject> songs;
        final int index;
        final long positionMs;
        final int repeat;

        Saved(List<JSONObject> songs, int index, long positionMs, int repeat) {
            this.songs = songs;
            this.index = index;
            this.positionMs = positionMs;
            this.repeat = repeat;
        }
    }

    private final File file;
    private final Player player;
    private final ExecutorService io;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final Runnable save = this::save;

    QueueMemory(Context context, Player player, ExecutorService io) {
        this.file = new File(context.getFilesDir(), FILE);
        this.player = player;
        this.io = io;
        player.addListener(this);
        // The player may already hold songs (the web app loaded them first).
        main.postDelayed(save, SAVE_DELAY_MS);
    }

    void release() {
        main.removeCallbacks(save);
        save();
        player.removeListener(this);
    }

    @Override
    public void onEvents(Player player, Player.Events events) {
        if (events.containsAny(
            Player.EVENT_MEDIA_ITEM_TRANSITION,
            Player.EVENT_TIMELINE_CHANGED,
            Player.EVENT_IS_PLAYING_CHANGED,
            Player.EVENT_POSITION_DISCONTINUITY,
            Player.EVENT_REPEAT_MODE_CHANGED,
            Player.EVENT_SHUFFLE_MODE_ENABLED_CHANGED)) {
            main.removeCallbacks(save);
            main.postDelayed(save, SAVE_DELAY_MS);
        }
    }

    /** Writes the player's queue, in playing order. Main thread. */
    private void save() {
        Timeline timeline = player.getCurrentTimeline();
        if (timeline.isEmpty()) return;
        boolean shuffle = player.getShuffleModeEnabled();
        int current = player.getCurrentMediaItemIndex();
        JSONArray songs = new JSONArray();
        int index = -1;
        int at = timeline.getFirstWindowIndex(shuffle);
        while (at != C.INDEX_UNSET) {
            String song = songOf(player.getMediaItemAt(at));
            if (song != null) {
                if (at == current) index = songs.length();
                try {
                    songs.put(new JSONObject(song));
                } catch (JSONException ignored) {
                    // Not a song; left out.
                }
            }
            at = timeline.getNextWindowIndex(at, Player.REPEAT_MODE_OFF, shuffle);
        }
        if (index < 0 || songs.length() == 0) return;
        JSONObject data = new JSONObject();
        try {
            data.put("songs", songs);
            data.put("index", index);
            data.put("positionMs", Math.max(0, player.getCurrentPosition()));
            // The web app repeats its queue itself; a car queue, the player.
            data.put("repeat", PlaybackEngine.isCarQueue()
                ? player.getRepeatMode()
                : PlaybackEngine.webModes().repeat);
        } catch (JSONException e) {
            return;
        }
        String text = data.toString();
        io.execute(() -> write(text));
    }

    private void write(String text) {
        File partial = new File(file.getPath() + ".part");
        try (OutputStream out = new FileOutputStream(partial)) {
            out.write(text.getBytes(StandardCharsets.UTF_8));
        } catch (IOException e) {
            Log.w(TAG, "Could not remember the queue", e);
            return;
        }
        if (!partial.renameTo(file)) Log.w(TAG, "Could not remember the queue");
    }

    /** The queue last remembered, or null. Blocks: read it off the main thread. */
    @Nullable
    static Saved load(Context context) {
        File file = new File(context.getFilesDir(), FILE);
        if (!file.exists()) return null;
        try {
            JSONObject data = new JSONObject(readAll(file));
            JSONArray array = data.getJSONArray("songs");
            List<JSONObject> songs = new ArrayList<>();
            for (int i = 0; i < array.length(); i++) songs.add(array.getJSONObject(i));
            if (songs.isEmpty()) return null;
            int index = Math.max(0, Math.min(songs.size() - 1, data.optInt("index", 0)));
            return new Saved(
                songs, index, data.optLong("positionMs", 0),
                data.optInt("repeat", Player.REPEAT_MODE_OFF));
        } catch (IOException | JSONException e) {
            Log.w(TAG, "Could not read the remembered queue", e);
            return null;
        }
    }

    private static String readAll(File file) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        try (InputStream in = new FileInputStream(file)) {
            byte[] buffer = new byte[16384];
            int read;
            while ((read = in.read(buffer)) != -1) out.write(buffer, 0, read);
        }
        return out.toString("UTF-8");
    }

    @Nullable
    static String songOf(MediaItem item) {
        Bundle extras = item.mediaMetadata.extras;
        return extras != null ? extras.getString(CarLibrary.EXTRA_SONG) : null;
    }
}

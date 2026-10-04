package xyz.bsums.aonsoku;

import android.app.PendingIntent;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.util.Log;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.annotation.OptIn;
import androidx.media3.common.C;
import androidx.media3.common.ForwardingPlayer;
import androidx.media3.common.MediaItem;
import androidx.media3.common.Player;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.session.CommandButton;
import androidx.media3.session.DefaultMediaNotificationProvider;
import androidx.media3.session.LibraryResult;
import androidx.media3.session.MediaConstants;
import androidx.media3.session.MediaLibraryService;
import androidx.media3.session.MediaSession;
import androidx.media3.session.SessionCommand;
import androidx.media3.session.SessionCommands;
import androidx.media3.session.SessionError;
import androidx.media3.session.SessionResult;

import com.google.common.collect.ImmutableList;

import org.json.JSONObject;
import com.google.common.util.concurrent.Futures;
import com.google.common.util.concurrent.ListenableFuture;
import com.google.common.util.concurrent.ListeningExecutorService;
import com.google.common.util.concurrent.MoreExecutors;

import java.io.IOException;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.Executors;

/**
 * Keeps songs playing in the background and gives the system its media
 * session: the notification, lock screen controls, headset and car buttons.
 * The player itself is PlaybackEngine's.
 *
 * The player only holds the tracks around the current one (the web app owns
 * the queue), so next and previous move within those and fall back to the
 * web app beyond them.
 *
 * It is also what Android Auto browses (see CarLibrary). A pick in the car
 * plays here at once, whether or not the app is open; the web app adopts
 * that queue when it runs (see PlaybackEngine.isCarQueue).
 */
public class PlaybackService extends MediaLibraryService {

    private static final String TAG = "NativePlayer";

    // The buttons beside play/pause in the car and the notification.
    private static final SessionCommand FAVORITE =
        new SessionCommand("xyz.bsums.aonsoku.FAVORITE", Bundle.EMPTY);
    private static final SessionCommand SHUFFLE =
        new SessionCommand("xyz.bsums.aonsoku.SHUFFLE", Bundle.EMPTY);
    private static final SessionCommand REPEAT =
        new SessionCommand("xyz.bsums.aonsoku.REPEAT", Bundle.EMPTY);

    private MediaLibrarySession session;
    private ExoPlayer player;
    private CarLibrary library;
    private CarScrobbler scrobbler;
    private QueueMemory memory;
    // Favourites changed from the car while it plays its own queue, by song.
    private final Map<String, Boolean> starred = new HashMap<>();
    private final Player.Listener buttonUpdater = new Player.Listener() {
        @Override
        public void onEvents(@NonNull Player player, @NonNull Player.Events events) {
            if (showingLastQueue && events.contains(Player.EVENT_PLAY_WHEN_READY_CHANGED)
                && player.getPlayWhenReady()) {
                // Played from the car: the car's queue now.
                showingLastQueue = false;
                if (!PlaybackEngine.hasWebApp()) PlaybackEngine.startCarQueue();
            }
            if (events.contains(Player.EVENT_TIMELINE_CHANGED)
                && player.getMediaItemCount() == 0) {
                showingLastQueue = false;
            }
            if (events.containsAny(
                Player.EVENT_MEDIA_ITEM_TRANSITION,
                Player.EVENT_SHUFFLE_MODE_ENABLED_CHANGED,
                Player.EVENT_REPEAT_MODE_CHANGED)) {
                updateButtons();
            }
        }
    };
    private final ListeningExecutorService network =
        MoreExecutors.listeningDecorator(Executors.newFixedThreadPool(3));

    @OptIn(markerClass = UnstableApi.class)
    @Override
    public void onCreate() {
        super.onCreate();

        player = PlaybackEngine.get(this);
        library = new CarLibrary(this);
        scrobbler = new CarScrobbler(this, player, network);
        memory = new QueueMemory(this, player, network);
        player.addListener(buttonUpdater);
        PlaybackEngine.setModesListener(this::updateButtons);

        DefaultMediaNotificationProvider notifications =
            new DefaultMediaNotificationProvider.Builder(this).build();
        notifications.setSmallIcon(R.drawable.ic_notification);
        setMediaNotificationProvider(notifications);

        MediaLibrarySession.Builder builder =
            new MediaLibrarySession.Builder(this, new QueuePlayer(player), new LibraryCallback());
        PendingIntent launch = launchIntent();
        if (launch != null) builder.setSessionActivity(launch);
        builder.setMediaButtonPreferences(buttons());
        session = builder.build();
        // Signing in or out on the phone shows in the car at once.
        AonsokuServer.setChangeListener(this::refreshLibrary);
        DebugLog.i(TAG, "media session created");
    }

    /** Has the car load its lists again (the sign-in changed). */
    private void refreshLibrary() {
        if (session == null) return;
        DebugLog.i(TAG, "library refreshed");
        session.clearReplicatedLibraryError();
        for (String id : new String[] {
            CarLibrary.ROOT, CarLibrary.HOME, CarLibrary.ALBUMS, CarLibrary.ARTISTS,
            CarLibrary.PLAYLISTS, CarLibrary.FAVORITES,
        }) {
            session.notifyChildrenChanged(id, Integer.MAX_VALUE, null);
        }
    }

    @Override
    public MediaLibrarySession onGetSession(@NonNull MediaSession.ControllerInfo controllerInfo) {
        return session;
    }

    @Override
    public void onTaskRemoved(Intent rootIntent) {
        // Closing the app from recents stops the music, as it always has:
        // the web app that owns the queue is gone with it. A queue started
        // from the car is held here whole, so it plays on.
        if (PlaybackEngine.isCarQueue()) return;
        ExoPlayer player = PlaybackEngine.peek();
        if (player != null) {
            player.pause();
            player.stop();
        }
        stopSelf();
    }

    @Override
    public void onDestroy() {
        DebugLog.i(TAG, "media session closed");
        AonsokuServer.setChangeListener(null);
        PlaybackEngine.setModesListener(null);
        if (player != null) player.removeListener(buttonUpdater);
        if (memory != null) {
            memory.release();
            memory = null;
        }
        if (scrobbler != null) {
            scrobbler.release();
            scrobbler = null;
        }
        if (session != null) {
            session.release();
            session = null;
        }
        network.shutdown();
        super.onDestroy();
    }

    /**
     * Whether the buttons act on the player itself: for a car queue, or with
     * no web app running. Otherwise the web app, which owns the queue, does.
     */
    private boolean playerOwnsQueue() {
        return PlaybackEngine.isCarQueue() || !PlaybackEngine.hasWebApp();
    }

    /** Favourite, shuffle and repeat, showing their state. */
    private List<CommandButton> buttons() {
        boolean own = player == null || playerOwnsQueue();
        PlaybackEngine.Modes web = PlaybackEngine.webModes();
        boolean shuffle = own ? player != null && player.getShuffleModeEnabled() : web.shuffle;
        int repeat = own ? (player != null ? player.getRepeatMode() : Player.REPEAT_MODE_OFF)
            : web.repeat;
        boolean favorite = own ? isStarred() : web.starred;

        List<CommandButton> buttons = new ArrayList<>();
        buttons.add(new CommandButton.Builder(
                favorite ? CommandButton.ICON_HEART_FILLED : CommandButton.ICON_HEART_UNFILLED)
            .setDisplayName(favorite ? "Remove from favorites" : "Add to favorites")
            .setSessionCommand(FAVORITE)
            .setSlots(CommandButton.SLOT_OVERFLOW)
            .build());
        buttons.add(new CommandButton.Builder(
                shuffle ? CommandButton.ICON_SHUFFLE_ON : CommandButton.ICON_SHUFFLE_OFF)
            .setDisplayName(shuffle ? "Shuffle off" : "Shuffle")
            .setSessionCommand(SHUFFLE)
            .setSlots(CommandButton.SLOT_OVERFLOW)
            .build());
        int icon = repeat == Player.REPEAT_MODE_ONE ? CommandButton.ICON_REPEAT_ONE
            : repeat == Player.REPEAT_MODE_ALL ? CommandButton.ICON_REPEAT_ALL
            : CommandButton.ICON_REPEAT_OFF;
        buttons.add(new CommandButton.Builder(icon)
            .setDisplayName(repeat == Player.REPEAT_MODE_ONE ? "Repeat one"
                : repeat == Player.REPEAT_MODE_ALL ? "Repeat all" : "Repeat off")
            .setSessionCommand(REPEAT)
            .setSlots(CommandButton.SLOT_OVERFLOW)
            .build());
        return buttons;
    }

    private void updateButtons() {
        if (session != null) session.setMediaButtonPreferences(buttons());
    }

    /** Whether the current song is a favourite (car queue). */
    private boolean isStarred() {
        if (player == null) return false;
        MediaItem item = player.getCurrentMediaItem();
        if (item == null) return false;
        String songId = CarLibrary.songIdOf(item);
        if (songId != null && starred.containsKey(songId)) {
            return Boolean.TRUE.equals(starred.get(songId));
        }
        String song = QueueMemory.songOf(item);
        if (song == null) return false;
        try {
            return new JSONObject(song).has("starred");
        } catch (org.json.JSONException e) {
            return false;
        }
    }

    /** Favourites the current song, or stops (car queue). */
    private void toggleStarred() {
        MediaItem item = player.getCurrentMediaItem();
        String songId = item != null ? CarLibrary.songIdOf(item) : null;
        if (songId == null) return;
        boolean star = !isStarred();
        starred.put(songId, star);
        updateButtons();
        network.execute(() -> {
            AonsokuServer server = AonsokuServer.load(this);
            if (server == null) return;
            try {
                server.call(star ? "star" : "unstar", AonsokuServer.map("id", songId));
            } catch (IOException e) {
                Log.w(TAG, "Could not change the favourite", e);
            }
        });
    }

    // The last queue, loaded paused for the car to show (see showLastQueue).
    private boolean showingLastQueue;

    /**
     * A car (or the system's controls) connected with nothing loaded and the
     * app closed: load the last queue, paused, so the car shows it and play
     * picks up where it left off. Once it plays it is a car queue; the web
     * app, if it starts first, loads its own queue over it.
     */
    private void showLastQueue() {
        if (player == null || player.getMediaItemCount() > 0 || PlaybackEngine.hasWebApp()) {
            return;
        }
        network.execute(() -> {
            QueueMemory.Saved saved = QueueMemory.load(this);
            AonsokuServer server = AonsokuServer.load(this);
            if (saved == null || server == null) return;
            List<MediaItem> items = new ArrayList<>();
            for (JSONObject song : saved.songs) {
                items.add(library.songItem(server, song, resumeId(song)));
            }
            new android.os.Handler(android.os.Looper.getMainLooper()).post(() -> {
                if (player == null || player.getMediaItemCount() > 0
                    || PlaybackEngine.hasWebApp()) {
                    return;
                }
                DebugLog.i(TAG, "showing the last queue, " + items.size() + " songs");
                // Saved in playing order: shuffled already, if it was.
                player.setShuffleModeEnabled(false);
                player.setRepeatMode(saved.repeat);
                player.setMediaItems(items, saved.index, saved.positionMs);
                player.setPlayWhenReady(false);
                // Prepared (paused) so the car shows it as ready to play.
                player.prepare();
                showingLastQueue = true;
            });
        });
    }

    /** Shuffles the rest of the queue after the current song, or stops. */
    private void toggleShuffle() {
        if (player.getShuffleModeEnabled()) {
            player.setShuffleModeEnabled(false);
        } else {
            PlaybackEngine.shuffleFromCurrent(player);
            player.setShuffleModeEnabled(true);
        }
    }

    private void cycleRepeat() {
        int repeat = player.getRepeatMode();
        // As the app cycles: off, all, one.
        player.setRepeatMode(repeat == Player.REPEAT_MODE_OFF ? Player.REPEAT_MODE_ALL
            : repeat == Player.REPEAT_MODE_ALL ? Player.REPEAT_MODE_ONE
            : Player.REPEAT_MODE_OFF);
    }

    @Nullable
    private PendingIntent launchIntent() {
        Intent launch = getPackageManager().getLaunchIntentForPackage(getPackageName());
        if (launch == null) return null;
        return PendingIntent.getActivity(
            this, 0, launch, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    /** Android Auto's browsing, search and picks, and the buttons. */
    private final class LibraryCallback implements MediaLibrarySession.Callback {

        @NonNull
        @Override
        public ListenableFuture<MediaSession.ConnectionResult> onConnectAsync(
            @NonNull MediaSession session, @NonNull MediaSession.ControllerInfo controller
        ) {
            MediaSession.ConnectionResult defaults =
                new MediaSession.ConnectionResult.AcceptedResultBuilder(session, controller)
                    .build();
            if (isExternal(controller)) {
                PlaybackEngine.externalControllerConnected();
                showLastQueue();
            }
            SessionCommands commands = defaults.availableSessionCommands.buildUpon()
                .add(FAVORITE)
                .add(SHUFFLE)
                .add(REPEAT)
                .build();
            return Futures.immediateFuture(
                new MediaSession.ConnectionResult.AcceptedResultBuilder(session, controller)
                    .setAvailableSessionCommands(commands)
                    .setMediaButtonPreferences(buttons())
                    .build());
        }

        @Override
        public void onDisconnected(
            @NonNull MediaSession session, @NonNull MediaSession.ControllerInfo controller
        ) {
            if (!isExternal(controller)) return;
            PlaybackEngine.externalControllerDisconnected();
            // Kept for the car (see NativePlayerPlugin.closeSession); with
            // the car gone and nothing to play, it can go.
            if (!PlaybackEngine.hasExternalControllers()
                && (player == null || player.getMediaItemCount() == 0)) {
                stopSelf();
            }
        }

        @NonNull
        @Override
        public ListenableFuture<SessionResult> onCustomCommand(
            @NonNull MediaSession session,
            @NonNull MediaSession.ControllerInfo controller,
            @NonNull SessionCommand command,
            @NonNull Bundle args
        ) {
            boolean own = playerOwnsQueue();
            switch (command.customAction) {
                case "xyz.bsums.aonsoku.FAVORITE":
                    if (own) toggleStarred(); else PlaybackEngine.sendCommand("togglestar");
                    break;
                case "xyz.bsums.aonsoku.SHUFFLE":
                    if (own) {
                        toggleShuffle();
                    } else {
                        PlaybackEngine.sendCommand("toggleshuffle");
                    }
                    break;
                case "xyz.bsums.aonsoku.REPEAT":
                    if (own) cycleRepeat(); else PlaybackEngine.sendCommand("togglerepeat");
                    break;
                default:
                    return Futures.immediateFuture(
                        new SessionResult(SessionError.ERROR_NOT_SUPPORTED));
            }
            return Futures.immediateFuture(new SessionResult(SessionResult.RESULT_SUCCESS));
        }

        /**
         * Play with nothing loaded (the car connecting, a headset's play
         * button, the system's media controls): resume what played last.
         */
        @NonNull
        @Override
        public ListenableFuture<MediaSession.MediaItemsWithStartPosition> onPlaybackResumption(
            @NonNull MediaSession mediaSession,
            @NonNull MediaSession.ControllerInfo controller,
            boolean isForPlayback
        ) {
            return network.submit(() -> {
                QueueMemory.Saved saved = QueueMemory.load(PlaybackService.this);
                AonsokuServer server = AonsokuServer.load(PlaybackService.this);
                if (saved == null || server == null) throw new IOException("Nothing to resume");
                if (!isForPlayback) {
                    // Only shown (by the system), not played: the one song.
                    JSONObject song = saved.songs.get(saved.index);
                    return new MediaSession.MediaItemsWithStartPosition(
                        java.util.Collections.singletonList(library.songItem(
                            server, song, resumeId(song))),
                        0, saved.positionMs);
                }
                List<MediaItem> items = new ArrayList<>();
                for (JSONObject song : saved.songs) {
                    items.add(library.songItem(server, song, resumeId(song)));
                }
                DebugLog.i(TAG, "resuming " + items.size() + " songs at " + saved.index);
                int repeat = saved.repeat;
                new android.os.Handler(android.os.Looper.getMainLooper()).post(() -> {
                    if (player == null) return;
                    // Saved in playing order: shuffled already, if it was.
                    player.setShuffleModeEnabled(false);
                    player.setRepeatMode(repeat);
                });
                return new MediaSession.MediaItemsWithStartPosition(
                    items, saved.index, saved.positionMs);
            });
        }

        @NonNull
        @Override
        public ListenableFuture<LibraryResult<MediaItem>> onGetLibraryRoot(
            @NonNull MediaLibrarySession session,
            @NonNull MediaSession.ControllerInfo browser,
            @Nullable LibraryParams params
        ) {
            // Never an error here: Android Auto would not connect at all.
            LibraryParams result = new LibraryParams.Builder()
                .setExtras(CarLibrary.rootExtras())
                .build();
            return Futures.immediateFuture(LibraryResult.ofItem(CarLibrary.root(), result));
        }

        @NonNull
        @Override
        public ListenableFuture<LibraryResult<MediaItem>> onGetItem(
            @NonNull MediaLibrarySession session,
            @NonNull MediaSession.ControllerInfo browser,
            @NonNull String mediaId
        ) {
            return network.submit(() -> {
                try {
                    MediaItem item = library.item(mediaId);
                    return item != null
                        ? LibraryResult.ofItem(item, null)
                        : LibraryResult.ofError(SessionError.ERROR_BAD_VALUE);
                } catch (IOException e) {
                    return error(e, null);
                }
            });
        }

        @NonNull
        @Override
        public ListenableFuture<LibraryResult<ImmutableList<MediaItem>>> onGetChildren(
            @NonNull MediaLibrarySession session,
            @NonNull MediaSession.ControllerInfo browser,
            @NonNull String parentId,
            int page,
            int pageSize,
            @Nullable LibraryParams params
        ) {
            return network.submit(() -> {
                try {
                    List<MediaItem> children = library.children(parentId);
                    if (parentId.equals(CarLibrary.ROOT)) {
                        children = limitRoot(children, params);
                    }
                    return LibraryResult.ofItemList(pageOf(children, page, pageSize), params);
                } catch (CarLibrary.SignedOutException e) {
                    // A tab says where to sign in; an error would show as
                    // an empty list.
                    if (CarLibrary.isTab(parentId)) {
                        return LibraryResult.ofItemList(
                            ImmutableList.copyOf(CarLibrary.signInHint()), params);
                    }
                    return error(e, params);
                } catch (IOException e) {
                    return error(e, params);
                }
            });
        }

        @NonNull
        @Override
        public ListenableFuture<LibraryResult<Void>> onSearch(
            @NonNull MediaLibrarySession session,
            @NonNull MediaSession.ControllerInfo browser,
            @NonNull String query,
            @Nullable LibraryParams params
        ) {
            // The results are fetched when asked for; this only says they
            // are ready, which is what makes Android Auto ask.
            session.notifySearchResultChanged(browser, query, 1, params);
            return Futures.immediateFuture(LibraryResult.ofVoid());
        }

        @NonNull
        @Override
        public ListenableFuture<LibraryResult<ImmutableList<MediaItem>>> onGetSearchResult(
            @NonNull MediaLibrarySession session,
            @NonNull MediaSession.ControllerInfo browser,
            @NonNull String query,
            int page,
            int pageSize,
            @Nullable LibraryParams params
        ) {
            return network.submit(() -> {
                try {
                    return LibraryResult.ofItemList(
                        pageOf(library.search(query), page, pageSize), params);
                } catch (IOException e) {
                    return error(e, params);
                }
            });
        }

        /**
         * A pick in the car (or "play ..." by voice) arrives as an ID or a
         * search, without anything to stream: turn it into its songs. A song
         * plays on through the list it was picked from.
         */
        @NonNull
        @Override
        public ListenableFuture<MediaSession.MediaItemsWithStartPosition> onSetMediaItems(
            @NonNull MediaSession mediaSession,
            @NonNull MediaSession.ControllerInfo controller,
            @NonNull List<MediaItem> mediaItems,
            int startIndex,
            long startPositionMs
        ) {
            return network.submit(() -> {
                if (mediaItems.size() == 1) {
                    CarLibrary.Queue queue = library.resolve(mediaItems.get(0));
                    if (queue.items.isEmpty()) throw new IOException("Nothing to play");
                    return new MediaSession.MediaItemsWithStartPosition(
                        queue.items, queue.startIndex, C.TIME_UNSET);
                }
                List<MediaItem> songs = new ArrayList<>();
                for (MediaItem item : mediaItems) songs.addAll(library.resolve(item).items);
                return new MediaSession.MediaItemsWithStartPosition(
                    songs, Math.max(0, startIndex), startPositionMs);
            });
        }

        @NonNull
        @Override
        public ListenableFuture<List<MediaItem>> onAddMediaItems(
            @NonNull MediaSession mediaSession,
            @NonNull MediaSession.ControllerInfo controller,
            @NonNull List<MediaItem> mediaItems
        ) {
            return network.submit(() -> {
                List<MediaItem> songs = new ArrayList<>();
                for (MediaItem item : mediaItems) {
                    if (item.localConfiguration != null) {
                        songs.add(item);
                    } else if (item.mediaId.startsWith("song/")) {
                        // Added on its own, not with the list it is in.
                        CarLibrary.Queue queue = library.resolve(item);
                        if (!queue.items.isEmpty()) songs.add(queue.items.get(queue.startIndex));
                    } else {
                        songs.addAll(library.resolve(item).items);
                    }
                }
                return songs;
            });
        }
    }

    private boolean isExternal(MediaSession.ControllerInfo controller) {
        return !getPackageName().equals(controller.getPackageName());
    }

    private static String resumeId(JSONObject song) {
        return "song/" + Uri.encode(song.optString("id")) + "/one";
    }

    /** Signed out, or the server refused the sign-in: say so in the car. */
    private <V> LibraryResult<V> error(IOException e, @Nullable LibraryParams params) {
        boolean signIn = e instanceof CarLibrary.SignedOutException
            || (e instanceof AonsokuServer.ServerException
                && ((AonsokuServer.ServerException) e).isSignIn());
        if (!signIn) {
            Log.w(TAG, "Car library request failed", e);
            return LibraryResult.ofError(
                new SessionError(SessionError.ERROR_IO, "Couldn't reach your music server"),
                params);
        }
        Bundle extras = new Bundle();
        extras.putString(MediaConstants.EXTRAS_KEY_ERROR_RESOLUTION_ACTION_LABEL_COMPAT,
            "Open Aonsoku");
        PendingIntent launch = launchIntent();
        if (launch != null) {
            extras.putParcelable(
                MediaConstants.EXTRAS_KEY_ERROR_RESOLUTION_ACTION_INTENT_COMPAT, launch);
        }
        LibraryParams errorParams = new LibraryParams.Builder().setExtras(extras).build();
        return LibraryResult.ofError(
            new SessionError(
                SessionError.ERROR_SESSION_AUTHENTICATION_EXPIRED,
                "Sign in to Aonsoku on your phone",
                extras),
            errorParams);
    }

    /** As many tabs as the car shows (four unless it says otherwise). */
    private static List<MediaItem> limitRoot(List<MediaItem> tabs, @Nullable LibraryParams params) {
        int limit = 4;
        if (params != null) {
            limit = params.extras.getInt(MediaConstants.EXTRAS_KEY_ROOT_CHILDREN_LIMIT, 4);
        }
        return tabs.size() > limit ? tabs.subList(0, Math.max(1, limit)) : tabs;
    }

    private static ImmutableList<MediaItem> pageOf(List<MediaItem> items, int page, int pageSize) {
        if (pageSize <= 0 || pageSize == Integer.MAX_VALUE) return ImmutableList.copyOf(items);
        long from = (long) page * pageSize;
        if (from >= items.size()) return ImmutableList.of();
        int to = (int) Math.min(items.size(), from + pageSize);
        return ImmutableList.copyOf(items.subList((int) from, to));
    }

    /**
     * Offers next/previous everywhere, handled by PlaybackEngine. A new list
     * set through the session can only come from outside the app (the car,
     * the assistant): the web app loads the player directly. It is marked as
     * a car queue, held here until the web app adopts it.
     */
    private static final class QueuePlayer extends ForwardingPlayer {

        QueuePlayer(Player player) {
            super(player);
        }

        @Override
        public void setMediaItems(@NonNull List<MediaItem> mediaItems) {
            // First, so the change it makes is already the car's.
            PlaybackEngine.startCarQueue();
            super.setMediaItems(mediaItems);
            // Shuffled, the pick still plays first.
            if (getShuffleModeEnabled()) PlaybackEngine.shuffleFromCurrent(PlaybackEngine.peek());
        }

        @Override
        public void setMediaItems(@NonNull List<MediaItem> mediaItems, boolean resetPosition) {
            PlaybackEngine.startCarQueue();
            super.setMediaItems(mediaItems, resetPosition);
            // Shuffled, the pick still plays first.
            if (getShuffleModeEnabled()) PlaybackEngine.shuffleFromCurrent(PlaybackEngine.peek());
        }

        @Override
        public void setMediaItems(
            @NonNull List<MediaItem> mediaItems, int startIndex, long startPositionMs
        ) {
            PlaybackEngine.startCarQueue();
            super.setMediaItems(mediaItems, startIndex, startPositionMs);
            // Shuffled, the pick still plays first.
            if (getShuffleModeEnabled()) PlaybackEngine.shuffleFromCurrent(PlaybackEngine.peek());
        }

        @Override
        public void seekToNext() {
            PlaybackEngine.skipToNext(getWrappedPlayer());
        }

        @Override
        public void seekToNextMediaItem() {
            PlaybackEngine.skipToNext(getWrappedPlayer());
        }

        @Override
        public void seekToPrevious() {
            PlaybackEngine.skipToPrevious(getWrappedPlayer());
        }

        @Override
        public void seekToPreviousMediaItem() {
            PlaybackEngine.skipToPrevious(getWrappedPlayer());
        }

        @Override
        public boolean hasNextMediaItem() {
            return true;
        }

        @Override
        public boolean hasPreviousMediaItem() {
            return true;
        }

        @Override
        public boolean isCommandAvailable(int command) {
            return isQueueCommand(command) || super.isCommandAvailable(command);
        }

        @NonNull
        @Override
        public Commands getAvailableCommands() {
            return super.getAvailableCommands().buildUpon()
                .addAll(
                    COMMAND_SEEK_TO_NEXT,
                    COMMAND_SEEK_TO_NEXT_MEDIA_ITEM,
                    COMMAND_SEEK_TO_PREVIOUS,
                    COMMAND_SEEK_TO_PREVIOUS_MEDIA_ITEM)
                .build();
        }

        private static boolean isQueueCommand(int command) {
            return command == COMMAND_SEEK_TO_NEXT
                || command == COMMAND_SEEK_TO_NEXT_MEDIA_ITEM
                || command == COMMAND_SEEK_TO_PREVIOUS
                || command == COMMAND_SEEK_TO_PREVIOUS_MEDIA_ITEM;
        }
    }
}

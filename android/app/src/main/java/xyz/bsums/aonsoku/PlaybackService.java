package xyz.bsums.aonsoku;

import android.app.PendingIntent;
import android.content.Intent;
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
import androidx.media3.session.DefaultMediaNotificationProvider;
import androidx.media3.session.LibraryResult;
import androidx.media3.session.MediaConstants;
import androidx.media3.session.MediaLibraryService;
import androidx.media3.session.MediaSession;
import androidx.media3.session.SessionError;

import com.google.common.collect.ImmutableList;
import com.google.common.util.concurrent.Futures;
import com.google.common.util.concurrent.ListenableFuture;
import com.google.common.util.concurrent.ListeningExecutorService;
import com.google.common.util.concurrent.MoreExecutors;

import java.io.IOException;
import java.util.ArrayList;
import java.util.List;
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

    private MediaLibrarySession session;
    private CarLibrary library;
    private CarScrobbler scrobbler;
    private final ListeningExecutorService network =
        MoreExecutors.listeningDecorator(Executors.newFixedThreadPool(3));

    @OptIn(markerClass = UnstableApi.class)
    @Override
    public void onCreate() {
        super.onCreate();

        ExoPlayer player = PlaybackEngine.get(this);
        library = new CarLibrary(this);
        scrobbler = new CarScrobbler(this, player, network);

        DefaultMediaNotificationProvider notifications =
            new DefaultMediaNotificationProvider.Builder(this).build();
        notifications.setSmallIcon(R.drawable.ic_notification);
        setMediaNotificationProvider(notifications);

        MediaLibrarySession.Builder builder =
            new MediaLibrarySession.Builder(this, new QueuePlayer(player), new LibraryCallback());
        PendingIntent launch = launchIntent();
        if (launch != null) builder.setSessionActivity(launch);
        session = builder.build();
        DebugLog.i(TAG, "media session created");
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

    @Nullable
    private PendingIntent launchIntent() {
        Intent launch = getPackageManager().getLaunchIntentForPackage(getPackageName());
        if (launch == null) return null;
        return PendingIntent.getActivity(
            this, 0, launch, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    /** Android Auto's browsing, search and picks. */
    private final class LibraryCallback implements MediaLibrarySession.Callback {

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
        }

        @Override
        public void setMediaItems(@NonNull List<MediaItem> mediaItems, boolean resetPosition) {
            PlaybackEngine.startCarQueue();
            super.setMediaItems(mediaItems, resetPosition);
        }

        @Override
        public void setMediaItems(
            @NonNull List<MediaItem> mediaItems, int startIndex, long startPositionMs
        ) {
            PlaybackEngine.startCarQueue();
            super.setMediaItems(mediaItems, startIndex, startPositionMs);
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

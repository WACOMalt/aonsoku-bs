package xyz.bsums.aonsoku;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import android.content.ComponentName;
import android.content.Context;
import android.os.Bundle;
import android.support.v4.media.MediaBrowserCompat;
import android.support.v4.media.MediaMetadataCompat;
import android.support.v4.media.session.MediaControllerCompat;
import android.support.v4.media.session.PlaybackStateCompat;
import android.util.Log;

import androidx.annotation.NonNull;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;

import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

/**
 * Browses and plays the way Android Auto does: as a legacy
 * MediaBrowserCompat client of PlaybackService. Needs a signed-in app (the
 * web app hands the server over; see NativePlayerPlugin.setServer).
 *
 * Run with: ./gradlew connectedDebugAndroidTest
 *   -Pandroid.testInstrumentationRunnerArguments.class=xyz.bsums.aonsoku.CarBrowseTest
 * and read the results with: adb logcat -s CarTest
 */
@RunWith(AndroidJUnit4.class)
public class CarBrowseTest {

    private static final String TAG = "CarTest";

    private Context context;
    private MediaBrowserCompat browser;

    @Before
    public void connect() throws Exception {
        context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        CountDownLatch connected = new CountDownLatch(1);
        InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> {
            browser = new MediaBrowserCompat(
                context,
                new ComponentName(context, PlaybackService.class),
                new MediaBrowserCompat.ConnectionCallback() {
                    @Override
                    public void onConnected() {
                        connected.countDown();
                    }
                },
                rootHints());
            browser.connect();
        });
        assertTrue("connects", connected.await(10, TimeUnit.SECONDS));
        Log.i(TAG, "root " + browser.getRoot() + " extras " + browser.getExtras());
    }

    @After
    public void disconnect() {
        InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> browser.disconnect());
    }

    @Test
    public void browsesTheLibrary() throws Exception {
        List<MediaBrowserCompat.MediaItem> tabs = children(browser.getRoot());
        assertFalse("has tabs", tabs.isEmpty());
        for (MediaBrowserCompat.MediaItem tab : tabs) {
            List<MediaBrowserCompat.MediaItem> items = children(tab.getMediaId());
            Log.i(TAG, "tab " + tab.getMediaId() + ": " + items.size() + " items");
        }
        List<MediaBrowserCompat.MediaItem> albums = children("albums/newest");
        assertFalse("has albums", albums.isEmpty());
        List<MediaBrowserCompat.MediaItem> songs = children(albums.get(0).getMediaId());
        assertFalse("album has songs", songs.isEmpty());
        assertTrue("songs are playable", songs.get(0).isPlayable());
    }

    @Test
    public void searches() throws Exception {
        CountDownLatch done = new CountDownLatch(1);
        AtomicReference<List<MediaBrowserCompat.MediaItem>> found = new AtomicReference<>();
        InstrumentationRegistry.getInstrumentation().runOnMainSync(() ->
            browser.search("the", null, new MediaBrowserCompat.SearchCallback() {
                @Override
                public void onSearchResult(
                    @NonNull String query, Bundle extras,
                    @NonNull List<MediaBrowserCompat.MediaItem> items
                ) {
                    found.set(items);
                    done.countDown();
                }

                @Override
                public void onError(@NonNull String query, Bundle extras) {
                    done.countDown();
                }
            }));
        assertTrue("search answers", done.await(20, TimeUnit.SECONDS));
        assertNotNull("search succeeds", found.get());
        for (MediaBrowserCompat.MediaItem item : found.get()) log("found", item);
    }

    /**
     * Picks the second song of an album, as a tap in the car does: the
     * newest album, or the one given as "albumId".
     */
    @Test
    public void playsAPick() throws Exception {
        List<MediaBrowserCompat.MediaItem> albums = children("albums/newest");
        String albumId = InstrumentationRegistry.getArguments().getString("albumId");
        List<MediaBrowserCompat.MediaItem> songs = children(
            albumId != null ? "album/" + albumId : albums.get(0).getMediaId());
        MediaBrowserCompat.MediaItem pick = songs.get(Math.min(1, songs.size() - 1));
        log("picking", pick);

        AtomicReference<MediaControllerCompat> controller = new AtomicReference<>();
        InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> {
            controller.set(new MediaControllerCompat(context, browser.getSessionToken()));
            controller.get().getTransportControls().playFromMediaId(pick.getMediaId(), null);
        });
        PlaybackStateCompat state = null;
        for (int i = 0; i < 40; i++) {
            Thread.sleep(500);
            state = controller.get().getPlaybackState();
            if (state != null && state.getState() == PlaybackStateCompat.STATE_PLAYING) break;
        }
        MediaMetadataCompat metadata = controller.get().getMetadata();
        Log.i(TAG, "state " + state + " playing "
            + (metadata != null ? metadata.getDescription().getTitle() : null)
            + " queue " + (controller.get().getQueue() != null
                ? controller.get().getQueue().size() : 0));
        assertNotNull(state);
        assertTrue("plays", state.getState() == PlaybackStateCompat.STATE_PLAYING);
        // Optionally a second pick later (e.g. once the app has been opened),
        // from another album: "repickAfterSeconds".
        String repick = InstrumentationRegistry.getArguments().getString("repickAfterSeconds");
        if (repick != null) {
            Thread.sleep(Long.parseLong(repick) * 1000);
            List<MediaBrowserCompat.MediaItem> others = children(albums.get(1).getMediaId());
            MediaBrowserCompat.MediaItem second = others.get(0);
            log("picking again", second);
            InstrumentationRegistry.getInstrumentation().runOnMainSync(() ->
                controller.get().getTransportControls().playFromMediaId(
                    second.getMediaId(), null));
        }
        String wait = InstrumentationRegistry.getArguments().getString("holdSeconds");
        if (wait != null) Thread.sleep(Long.parseLong(wait) * 1000);
    }

    private List<MediaBrowserCompat.MediaItem> children(String parentId) throws Exception {
        CountDownLatch done = new CountDownLatch(1);
        List<MediaBrowserCompat.MediaItem> result = new ArrayList<>();
        AtomicReference<String> error = new AtomicReference<>();
        MediaBrowserCompat.SubscriptionCallback callback =
            new MediaBrowserCompat.SubscriptionCallback() {
                @Override
                public void onChildrenLoaded(
                    @NonNull String id, @NonNull List<MediaBrowserCompat.MediaItem> items
                ) {
                    result.addAll(items);
                    done.countDown();
                }

                @Override
                public void onError(@NonNull String id) {
                    error.set(id);
                    done.countDown();
                }
            };
        InstrumentationRegistry.getInstrumentation().runOnMainSync(() ->
            browser.subscribe(parentId, callback));
        assertTrue("children of " + parentId, done.await(20, TimeUnit.SECONDS));
        InstrumentationRegistry.getInstrumentation().runOnMainSync(() ->
            browser.unsubscribe(parentId, callback));
        if (error.get() != null) {
            Log.i(TAG, "error loading " + parentId);
        }
        for (int i = 0; i < Math.min(3, result.size()); i++) log(parentId, result.get(i));
        return result;
    }

    private static void log(String what, MediaBrowserCompat.MediaItem item) {
        Log.i(TAG, what + ": " + item.getMediaId() + " \"" + item.getDescription().getTitle()
            + "\" art " + item.getDescription().getIconUri()
            + (item.isBrowsable() ? " browsable" : "") + (item.isPlayable() ? " playable" : ""));
    }

    private static Bundle rootHints() {
        Bundle hints = new Bundle();
        hints.putInt("androidx.media.MediaBrowserCompat.Extras.KEY_ROOT_CHILDREN_LIMIT", 4);
        return hints;
    }
}

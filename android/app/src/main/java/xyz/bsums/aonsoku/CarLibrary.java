package xyz.bsums.aonsoku;

import android.content.Context;
import android.net.Uri;
import android.os.Bundle;

import androidx.annotation.Nullable;
import androidx.media3.common.MediaItem;
import androidx.media3.common.MediaMetadata;
import androidx.media3.session.MediaConstants;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.IOException;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Locale;

/**
 * What Android Auto shows: a few tabs of the library, read from the server
 * (see AonsokuServer), and the songs a pick in the car plays.
 *
 * Kept simple for driving: Home (album lists and a shuffle), Artists,
 * Playlists and Favorites, each at most a level or two deep, and search.
 *
 * Media IDs:
 *   root, home, artists, playlists, favorites   the tabs
 *   albums/<type>                               an album list (recent, newest...)
 *   shuffle                                     random songs, playable
 *   artist/<id>, album/<id>, playlist/<id>      browsable
 *   song/<id>/<context>                         a song, played in its context:
 *                                               album/<id>, playlist/<id>,
 *                                               favorites or one (just the song)
 *
 * Every call here blocks on the network: call it off the main thread.
 */
final class CarLibrary {

    static final String ROOT = "root";
    static final String HOME = "home";
    static final String ARTISTS = "artists";
    static final String PLAYLISTS = "playlists";
    static final String FAVORITES = "favorites";
    static final String SHUFFLE = "shuffle";

    /** The song's Subsonic JSON, for the web app to adopt the queue. */
    static final String EXTRA_SONG = "aonsoku.song";

    // Search results and long lists are cut short: they are read while driving.
    private static final int LIST_LIMIT = 100;
    private static final int SHUFFLE_SIZE = 100;
    private static final int ARTWORK_SIZE = 512;

    private static final String[][] ALBUM_LISTS = {
        { "recent", "Recently played" },
        { "newest", "Recently added" },
        { "frequent", "Most played" },
        { "random", "Random albums" },
        { "starred", "Favorite albums" },
    };

    private final Context context;

    CarLibrary(Context context) {
        this.context = context.getApplicationContext();
    }

    /** Signed out of the web app, so there is nothing to browse. */
    static final class SignedOutException extends IOException {
        SignedOutException() {
            super("Signed out");
        }
    }

    private AonsokuServer server() throws SignedOutException {
        AonsokuServer server = AonsokuServer.load(context);
        if (server == null) throw new SignedOutException();
        return server;
    }

    static MediaItem root() {
        return folder(ROOT, "Aonsoku", null, MediaMetadata.MEDIA_TYPE_FOLDER_MIXED);
    }

    /** The tabs, and defaults for how lists show (see the root's extras). */
    static Bundle rootExtras() {
        Bundle extras = new Bundle();
        extras.putBoolean("android.media.browse.SEARCH_SUPPORTED", true);
        extras.putInt(MediaConstants.EXTRAS_KEY_CONTENT_STYLE_BROWSABLE,
            MediaConstants.EXTRAS_VALUE_CONTENT_STYLE_LIST_ITEM);
        extras.putInt(MediaConstants.EXTRAS_KEY_CONTENT_STYLE_PLAYABLE,
            MediaConstants.EXTRAS_VALUE_CONTENT_STYLE_LIST_ITEM);
        return extras;
    }

    /** One item by ID, for onGetItem. */
    @Nullable
    MediaItem item(String mediaId) throws IOException {
        switch (mediaId) {
            case ROOT: return root();
            case HOME: return tab(HOME);
            case ARTISTS: return tab(ARTISTS);
            case PLAYLISTS: return tab(PLAYLISTS);
            case FAVORITES: return tab(FAVORITES);
            case SHUFFLE: return shuffleItem();
            default: break;
        }
        String[] parts = mediaId.split("/");
        if (parts.length < 2) return null;
        String id = Uri.decode(parts[1]);
        switch (parts[0]) {
            case "albums":
                for (String[] list : ALBUM_LISTS) {
                    if (list[0].equals(id)) return albumList(list[0], list[1]);
                }
                return null;
            case "album": {
                JSONObject album = server().call("getAlbum", AonsokuServer.map("id", id))
                    .optJSONObject("album");
                return album == null ? null : albumItem(album);
            }
            case "artist": {
                JSONObject artist = server().call("getArtist", AonsokuServer.map("id", id))
                    .optJSONObject("artist");
                return artist == null ? null : artistItem(artist);
            }
            case "playlist": {
                JSONObject playlist = server().call("getPlaylist", AonsokuServer.map("id", id))
                    .optJSONObject("playlist");
                return playlist == null ? null : playlistItem(playlist);
            }
            case "song": {
                JSONObject song = server().call("getSong", AonsokuServer.map("id", id))
                    .optJSONObject("song");
                return song == null ? null : songItem(server(), song, mediaId);
            }
            default:
                return null;
        }
    }

    static boolean isTab(String mediaId) {
        return mediaId.equals(HOME) || mediaId.equals(ARTISTS) || mediaId.equals(PLAYLISTS)
            || mediaId.equals(FAVORITES);
    }

    /** What a tab shows while signed out: where to sign in. */
    static List<MediaItem> signInHint() {
        MediaMetadata metadata = new MediaMetadata.Builder()
            .setTitle("Sign in on your phone")
            .setSubtitle("Open Aonsoku on your phone and connect to your server")
            .setIsBrowsable(false)
            .setIsPlayable(false)
            .build();
        return Collections.singletonList(
            new MediaItem.Builder().setMediaId("signin").setMediaMetadata(metadata).build());
    }

    /** The children of a browsable item. */
    List<MediaItem> children(String parentId) throws IOException {
        switch (parentId) {
            case ROOT: {
                List<MediaItem> tabs = new ArrayList<>();
                for (String tab : new String[] { HOME, ARTISTS, PLAYLISTS, FAVORITES }) {
                    tabs.add(tab(tab));
                }
                return tabs;
            }
            case HOME: {
                server();
                List<MediaItem> items = new ArrayList<>();
                items.add(shuffleItem());
                for (String[] list : ALBUM_LISTS) items.add(albumList(list[0], list[1]));
                return items;
            }
            case ARTISTS:
                return artists();
            case PLAYLISTS:
                return playlists();
            case FAVORITES:
                return songs(starredSongs(), "favorites");
            default:
                break;
        }
        String[] parts = parentId.split("/");
        if (parts.length < 2) return Collections.emptyList();
        String id = Uri.decode(parts[1]);
        switch (parts[0]) {
            case "albums":
                return albums(server().call("getAlbumList2", AonsokuServer.map(
                    "type", id, "size", String.valueOf(LIST_LIMIT)))
                    .optJSONObject("albumList2"), "album");
            case "artist":
                return albums(server().call("getArtist", AonsokuServer.map("id", id))
                    .optJSONObject("artist"), "album");
            case "album":
                return songs(albumSongs(id), "album/" + Uri.encode(id));
            case "playlist":
                return songs(playlistSongs(id), "playlist/" + Uri.encode(id));
            default:
                return Collections.emptyList();
        }
    }

    /** Albums, artists and songs matching a search. */
    List<MediaItem> search(String query) throws IOException {
        AonsokuServer server = server();
        JSONObject result = server.call("search3", AonsokuServer.map(
            "query", query,
            "artistCount", "5",
            "albumCount", "10",
            "songCount", "30"))
            .optJSONObject("searchResult3");
        List<MediaItem> items = new ArrayList<>();
        if (result == null) return items;
        for (JSONObject artist : objects(result.optJSONArray("artist"))) {
            items.add(withGroup(artistItem(artist), "Artists"));
        }
        for (JSONObject album : objects(result.optJSONArray("album"))) {
            items.add(withGroup(albumItem(album), "Albums"));
        }
        for (JSONObject song : objects(result.optJSONArray("song"))) {
            String context = song.has("albumId")
                ? "album/" + Uri.encode(song.optString("albumId"))
                : "one";
            items.add(withGroup(songItem(server, song, songId(song, context)), "Songs"));
        }
        return items;
    }

    /** The songs to play, and where to start, for a pick in the car. */
    static final class Queue {
        final List<MediaItem> items;
        final int startIndex;

        Queue(List<MediaItem> items, int startIndex) {
            this.items = items;
            this.startIndex = startIndex;
        }
    }

    /**
     * What a picked item plays: a song plays on through the album, playlist
     * or favorites it was picked from; an album, playlist or artist plays
     * whole; a voice search plays what matches best.
     */
    Queue resolve(MediaItem picked) throws IOException {
        String mediaId = picked.mediaId;
        if (mediaId.isEmpty() || mediaId.equals(ROOT)) {
            CharSequence query = picked.requestMetadata.searchQuery;
            return playSearch(query == null ? "" : query.toString());
        }
        if (mediaId.equals(SHUFFLE)) return new Queue(randomSongs(), 0);

        AonsokuServer server = server();
        String[] parts = mediaId.split("/");
        String id = parts.length > 1 ? Uri.decode(parts[1]) : "";
        switch (parts[0]) {
            case "album":
                return new Queue(songItems(server, albumSongs(id), "album/" + Uri.encode(id)), 0);
            case "playlist":
                return new Queue(
                    songItems(server, playlistSongs(id), "playlist/" + Uri.encode(id)), 0);
            case "artist":
                return new Queue(artistSongs(server, id), 0);
            case "song": {
                String context = parts.length > 2
                    ? mediaId.substring(("song/" + parts[1] + "/").length())
                    : "one";
                List<JSONObject> songs;
                if (context.startsWith("album/")) {
                    songs = albumSongs(Uri.decode(context.substring("album/".length())));
                } else if (context.startsWith("playlist/")) {
                    songs = playlistSongs(Uri.decode(context.substring("playlist/".length())));
                } else if (context.equals("favorites")) {
                    songs = starredSongs();
                } else {
                    JSONObject song = server.call("getSong", AonsokuServer.map("id", id))
                        .optJSONObject("song");
                    songs = song == null ? new ArrayList<>() : Collections.singletonList(song);
                    context = "one";
                }
                List<MediaItem> items = songItems(server, songs, context);
                int start = 0;
                for (int i = 0; i < songs.size(); i++) {
                    if (songs.get(i).optString("id").equals(id)) {
                        start = i;
                        break;
                    }
                }
                return new Queue(items, start);
            }
            default:
                return new Queue(new ArrayList<>(), 0);
        }
    }

    /** "Play <query>" by voice: an artist, album or song, best match first. */
    private Queue playSearch(String query) throws IOException {
        if (query.trim().isEmpty()) return new Queue(randomSongs(), 0);
        AonsokuServer server = server();
        JSONObject result = server.call("search3", AonsokuServer.map(
            "query", query,
            "artistCount", "1",
            "albumCount", "1",
            "songCount", "20"))
            .optJSONObject("searchResult3");
        if (result == null) return new Queue(new ArrayList<>(), 0);
        String wanted = normalize(query);

        List<JSONObject> artists = objects(result.optJSONArray("artist"));
        if (!artists.isEmpty() && normalize(artists.get(0).optString("name")).equals(wanted)) {
            return new Queue(artistSongs(server, artists.get(0).optString("id")), 0);
        }
        List<JSONObject> albums = objects(result.optJSONArray("album"));
        if (!albums.isEmpty() && normalize(albums.get(0).optString("name")).equals(wanted)) {
            String albumId = albums.get(0).optString("id");
            return new Queue(
                songItems(server, albumSongs(albumId), "album/" + Uri.encode(albumId)), 0);
        }
        List<JSONObject> songs = objects(result.optJSONArray("song"));
        if (!songs.isEmpty()) return new Queue(songItems(server, songs, "one"), 0);
        if (!albums.isEmpty()) {
            String albumId = albums.get(0).optString("id");
            return new Queue(
                songItems(server, albumSongs(albumId), "album/" + Uri.encode(albumId)), 0);
        }
        if (!artists.isEmpty()) {
            return new Queue(artistSongs(server, artists.get(0).optString("id")), 0);
        }
        return new Queue(new ArrayList<>(), 0);
    }

    // Lists

    private List<MediaItem> artists() throws IOException {
        JSONObject artists = server().call("getArtists", null).optJSONObject("artists");
        List<MediaItem> items = new ArrayList<>();
        if (artists == null) return items;
        for (JSONObject index : objects(artists.optJSONArray("index"))) {
            for (JSONObject artist : objects(index.optJSONArray("artist"))) {
                items.add(artistItem(artist));
            }
        }
        return items;
    }

    private List<MediaItem> playlists() throws IOException {
        JSONObject playlists = server().call("getPlaylists", null).optJSONObject("playlists");
        List<MediaItem> items = new ArrayList<>();
        if (playlists == null) return items;
        for (JSONObject playlist : objects(playlists.optJSONArray("playlist"))) {
            items.add(playlistItem(playlist));
        }
        return items;
    }

    private List<MediaItem> albums(@Nullable JSONObject parent, String key) {
        List<MediaItem> items = new ArrayList<>();
        if (parent == null) return items;
        for (JSONObject album : objects(parent.optJSONArray(key))) items.add(albumItem(album));
        return items;
    }

    private List<MediaItem> songs(List<JSONObject> songs, String context) throws IOException {
        return songItems(server(), songs, context);
    }

    private List<JSONObject> albumSongs(String albumId) throws IOException {
        JSONObject album = server().call("getAlbum", AonsokuServer.map("id", albumId))
            .optJSONObject("album");
        return album == null ? new ArrayList<>() : objects(album.optJSONArray("song"));
    }

    private List<JSONObject> playlistSongs(String playlistId) throws IOException {
        JSONObject playlist = server().call("getPlaylist", AonsokuServer.map("id", playlistId))
            .optJSONObject("playlist");
        return playlist == null ? new ArrayList<>() : objects(playlist.optJSONArray("entry"));
    }

    private List<JSONObject> starredSongs() throws IOException {
        JSONObject starred = server().call("getStarred2", null).optJSONObject("starred2");
        return starred == null ? new ArrayList<>() : objects(starred.optJSONArray("song"));
    }

    private List<MediaItem> randomSongs() throws IOException {
        AonsokuServer server = server();
        JSONObject random = server.call("getRandomSongs", AonsokuServer.map(
            "size", String.valueOf(SHUFFLE_SIZE)))
            .optJSONObject("randomSongs");
        List<JSONObject> songs = random == null
            ? new ArrayList<>()
            : objects(random.optJSONArray("song"));
        return songItems(server, songs, "one");
    }

    /** All of an artist's albums, in order, then shuffled. */
    private List<MediaItem> artistSongs(AonsokuServer server, String artistId) throws IOException {
        JSONObject artist = server.call("getArtist", AonsokuServer.map("id", artistId))
            .optJSONObject("artist");
        List<JSONObject> songs = new ArrayList<>();
        if (artist != null) {
            for (JSONObject album : objects(artist.optJSONArray("album"))) {
                songs.addAll(albumSongs(album.optString("id")));
                if (songs.size() >= 500) break;
            }
        }
        Collections.shuffle(songs);
        return songItems(server, songs, "one");
    }

    // Items

    private MediaItem tab(String id) {
        switch (id) {
            case HOME:
                return folder(HOME, "Home", icon("ic_car_home"),
                    MediaMetadata.MEDIA_TYPE_FOLDER_MIXED);
            case ARTISTS:
                return folder(ARTISTS, "Artists", icon("ic_car_artists"),
                    MediaMetadata.MEDIA_TYPE_FOLDER_ARTISTS);
            case PLAYLISTS:
                return folder(PLAYLISTS, "Playlists", icon("ic_car_playlists"),
                    MediaMetadata.MEDIA_TYPE_FOLDER_PLAYLISTS);
            default:
                return folder(FAVORITES, "Favorites", icon("ic_car_favorites"),
                    MediaMetadata.MEDIA_TYPE_FOLDER_MIXED);
        }
    }

    /** A drawable of this app's, as the car takes icons. */
    private Uri icon(String name) {
        return Uri.parse("android.resource://" + context.getPackageName() + "/drawable/" + name);
    }

    private MediaItem albumList(String type, String title) {
        Bundle extras = new Bundle();
        extras.putInt(MediaConstants.EXTRAS_KEY_CONTENT_STYLE_BROWSABLE,
            MediaConstants.EXTRAS_VALUE_CONTENT_STYLE_GRID_ITEM);
        return folder("albums/" + type, title, null, extras, MediaMetadata.MEDIA_TYPE_FOLDER_ALBUMS);
    }

    private MediaItem shuffleItem() {
        MediaMetadata metadata = new MediaMetadata.Builder()
            .setTitle("Shuffle all")
            .setSubtitle("Random songs from your library")
            .setIsBrowsable(false)
            .setIsPlayable(true)
            .setMediaType(MediaMetadata.MEDIA_TYPE_PLAYLIST)
            .setArtworkUri(icon("ic_car_shuffle"))
            .build();
        return new MediaItem.Builder().setMediaId(SHUFFLE).setMediaMetadata(metadata).build();
    }

    private MediaItem artistItem(JSONObject artist) {
        Bundle extras = new Bundle();
        extras.putInt(MediaConstants.EXTRAS_KEY_CONTENT_STYLE_BROWSABLE,
            MediaConstants.EXTRAS_VALUE_CONTENT_STYLE_GRID_ITEM);
        int albums = artist.optInt("albumCount", 0);
        MediaMetadata.Builder metadata = new MediaMetadata.Builder()
            .setTitle(artist.optString("name"))
            .setSubtitle(albums == 1 ? "1 album" : albums + " albums")
            .setIsBrowsable(true)
            .setIsPlayable(false)
            .setMediaType(MediaMetadata.MEDIA_TYPE_ARTIST)
            .setExtras(extras);
        setArtwork(metadata, artist.optString("coverArt"));
        return new MediaItem.Builder()
            .setMediaId("artist/" + Uri.encode(artist.optString("id")))
            .setMediaMetadata(metadata.build())
            .build();
    }

    private MediaItem albumItem(JSONObject album) {
        MediaMetadata.Builder metadata = new MediaMetadata.Builder()
            .setTitle(album.optString("name", album.optString("title")))
            .setSubtitle(album.optString("artist"))
            .setArtist(album.optString("artist"))
            .setAlbumTitle(album.optString("name"))
            .setIsBrowsable(true)
            .setIsPlayable(false)
            .setMediaType(MediaMetadata.MEDIA_TYPE_ALBUM);
        int year = album.optInt("year", 0);
        if (year > 0) metadata.setReleaseYear(year);
        setArtwork(metadata, album.optString("coverArt"));
        return new MediaItem.Builder()
            .setMediaId("album/" + Uri.encode(album.optString("id")))
            .setMediaMetadata(metadata.build())
            .build();
    }

    private MediaItem playlistItem(JSONObject playlist) {
        int count = playlist.optInt("songCount", 0);
        MediaMetadata.Builder metadata = new MediaMetadata.Builder()
            .setTitle(playlist.optString("name"))
            .setSubtitle(count == 1 ? "1 song" : count + " songs")
            .setIsBrowsable(true)
            .setIsPlayable(false)
            .setMediaType(MediaMetadata.MEDIA_TYPE_PLAYLIST);
        setArtwork(metadata, playlist.optString("coverArt"));
        return new MediaItem.Builder()
            .setMediaId("playlist/" + Uri.encode(playlist.optString("id")))
            .setMediaMetadata(metadata.build())
            .build();
    }

    private List<MediaItem> songItems(
        AonsokuServer server, List<JSONObject> songs, String context
    ) {
        List<MediaItem> items = new ArrayList<>();
        for (JSONObject song : songs) items.add(songItem(server, song, songId(song, context)));
        return items;
    }

    private static String songId(JSONObject song, String context) {
        return "song/" + Uri.encode(song.optString("id")) + "/" + context;
    }

    /** A playable song: it streams from the server and carries its JSON. */
    private MediaItem songItem(AonsokuServer server, JSONObject song, String mediaId) {
        Bundle extras = new Bundle();
        extras.putString(EXTRA_SONG, song.toString());
        MediaMetadata.Builder metadata = new MediaMetadata.Builder()
            .setTitle(song.optString("title"))
            .setArtist(song.optString("artist"))
            .setSubtitle(song.optString("artist"))
            .setAlbumTitle(song.optString("album"))
            .setIsBrowsable(false)
            .setIsPlayable(true)
            .setMediaType(MediaMetadata.MEDIA_TYPE_MUSIC)
            .setExtras(extras);
        int duration = song.optInt("duration", 0);
        if (duration > 0) metadata.setDurationMs(duration * 1000L);
        int track = song.optInt("track", 0);
        if (track > 0) metadata.setTrackNumber(track);
        setArtwork(metadata, song.optString("coverArt"));
        return new MediaItem.Builder()
            .setMediaId(mediaId)
            .setUri(server.streamUrl(song.optString("id"), song.optString("suffix", null)))
            .setMediaMetadata(metadata.build())
            .build();
    }

    private void setArtwork(MediaMetadata.Builder metadata, @Nullable String coverArtId) {
        if (coverArtId == null || coverArtId.isEmpty()) return;
        metadata.setArtworkUri(ArtworkProvider.uri(context, coverArtId, ARTWORK_SIZE));
    }

    private static MediaItem folder(String id, String title, @Nullable Uri icon, int mediaType) {
        return folder(id, title, icon, null, mediaType);
    }

    private static MediaItem folder(
        String id, String title, @Nullable Uri icon, @Nullable Bundle extras, int mediaType
    ) {
        MediaMetadata.Builder metadata = new MediaMetadata.Builder()
            .setTitle(title)
            .setIsBrowsable(true)
            .setIsPlayable(false)
            .setMediaType(mediaType);
        if (icon != null) metadata.setArtworkUri(icon);
        if (extras != null) metadata.setExtras(extras);
        return new MediaItem.Builder().setMediaId(id).setMediaMetadata(metadata.build()).build();
    }

    /** Shows the item under a heading in a list (search results). */
    private static MediaItem withGroup(MediaItem item, String group) {
        Bundle extras = item.mediaMetadata.extras != null
            ? new Bundle(item.mediaMetadata.extras)
            : new Bundle();
        extras.putString(MediaConstants.EXTRAS_KEY_CONTENT_STYLE_GROUP_TITLE, group);
        return item.buildUpon()
            .setMediaMetadata(item.mediaMetadata.buildUpon().setExtras(extras).build())
            .build();
    }

    private static List<JSONObject> objects(@Nullable JSONArray array) {
        List<JSONObject> result = new ArrayList<>();
        if (array == null) return result;
        for (int i = 0; i < array.length(); i++) {
            try {
                result.add(array.getJSONObject(i));
            } catch (JSONException ignored) {
                // Not an object; skipped.
            }
        }
        return result;
    }

    private static String normalize(String text) {
        return text.toLowerCase(Locale.ROOT).replaceAll("[^\\p{L}\\p{N}]+", "");
    }
}

package xyz.bsums.aonsoku;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.util.Log;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;

import java.io.File;
import java.io.FileNotFoundException;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.Arrays;
import java.util.List;

/**
 * Cover art for Android Auto, which only shows artwork it can open as a
 * content:// URI, not a web address. The image is fetched from the server
 * the first time and kept in the cache.
 *
 * URIs: content://<package>.artwork/<coverArtId>/<size>.
 */
public class ArtworkProvider extends ContentProvider {

    private static final String TAG = "ArtworkProvider";
    private static final int TIMEOUT_MS = 15000;
    // Cached images kept; the oldest are removed beyond this.
    private static final int CACHE_LIMIT = 400;

    static Uri uri(Context context, String coverArtId, int size) {
        return new Uri.Builder()
            .scheme("content")
            .authority(authority(context))
            .appendPath(coverArtId)
            .appendPath(String.valueOf(size))
            .build();
    }

    private static String authority(Context context) {
        return context.getPackageName() + ".artwork";
    }

    @Override
    public boolean onCreate() {
        return true;
    }

    @Nullable
    @Override
    public ParcelFileDescriptor openFile(@NonNull Uri uri, @NonNull String mode)
        throws FileNotFoundException {
        Context context = getContext();
        List<String> segments = uri.getPathSegments();
        if (context == null || segments.size() != 2 || !"r".equals(mode)) {
            throw new FileNotFoundException(uri.toString());
        }
        String coverArtId = segments.get(0);
        int size;
        try {
            size = Math.max(64, Math.min(1024, Integer.parseInt(segments.get(1))));
        } catch (NumberFormatException e) {
            throw new FileNotFoundException(uri.toString());
        }

        File directory = new File(context.getCacheDir(), "artwork");
        File file = new File(directory, Integer.toHexString((coverArtId + "@" + size).hashCode())
            + "_" + coverArtId.replaceAll("[^A-Za-z0-9_-]", "_") + "_" + size);
        if (!file.exists()) {
            AonsokuServer server = AonsokuServer.load(context);
            if (server == null) throw new FileNotFoundException("Signed out");
            if (!directory.isDirectory() && !directory.mkdirs()) {
                throw new FileNotFoundException("No cache directory");
            }
            try {
                download(server.coverArtUrl(coverArtId, size), directory, file);
            } catch (IOException e) {
                Log.w(TAG, "Could not fetch cover art " + coverArtId, e);
                throw new FileNotFoundException(e.getMessage());
            }
            trim(directory);
        }
        return ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY);
    }

    private static void download(String url, File directory, File file) throws IOException {
        HttpURLConnection connection = (HttpURLConnection) new URL(url).openConnection();
        connection.setConnectTimeout(TIMEOUT_MS);
        connection.setReadTimeout(TIMEOUT_MS);
        File partial = File.createTempFile("artwork", ".part", directory);
        try {
            if (connection.getResponseCode() != HttpURLConnection.HTTP_OK) {
                throw new IOException("HTTP " + connection.getResponseCode());
            }
            String type = connection.getContentType();
            if (type != null && !type.startsWith("image/")) {
                throw new IOException("Not an image: " + type);
            }
            try (InputStream in = connection.getInputStream();
                 OutputStream out = new FileOutputStream(partial)) {
                byte[] buffer = new byte[16384];
                int read;
                while ((read = in.read(buffer)) != -1) out.write(buffer, 0, read);
            }
            if (!partial.renameTo(file)) throw new IOException("Could not save");
        } finally {
            connection.disconnect();
            if (partial.exists() && !partial.delete()) partial.deleteOnExit();
        }
    }

    private static void trim(File directory) {
        File[] files = directory.listFiles();
        if (files == null || files.length <= CACHE_LIMIT) return;
        Arrays.sort(files, (a, b) -> Long.compare(a.lastModified(), b.lastModified()));
        for (int i = 0; i < files.length - CACHE_LIMIT; i++) {
            if (!files[i].delete()) Log.w(TAG, "Could not remove " + files[i]);
        }
    }

    @Nullable
    @Override
    public String getType(@NonNull Uri uri) {
        return "image/*";
    }

    @Nullable
    @Override
    public Cursor query(
        @NonNull Uri uri, @Nullable String[] projection, @Nullable String selection,
        @Nullable String[] selectionArgs, @Nullable String sortOrder
    ) {
        return null;
    }

    @Nullable
    @Override
    public Uri insert(@NonNull Uri uri, @Nullable ContentValues values) {
        return null;
    }

    @Override
    public int delete(
        @NonNull Uri uri, @Nullable String selection, @Nullable String[] selectionArgs
    ) {
        return 0;
    }

    @Override
    public int update(
        @NonNull Uri uri, @Nullable ContentValues values, @Nullable String selection,
        @Nullable String[] selectionArgs
    ) {
        return 0;
    }
}

package xyz.bsums.aonsoku;

import android.content.Context;
import android.content.SharedPreferences;
import android.net.Uri;

import androidx.annotation.Nullable;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.Map;

/**
 * The Navidrome (Subsonic) server the web app is signed in to, for the parts
 * of the app that run without it: Android Auto browses and plays from here
 * while the app itself may not be open.
 *
 * The web app hands over its sign-in whenever it changes (see
 * NativePlayerPlugin.setServer). Like the web app, this keeps the password
 * only as the Subsonic token (or encoded password) the server accepts.
 */
final class AonsokuServer {

    private static final String PREFS = "aonsoku_server";
    // The salt the web app hashes its token with (src/utils/salt.ts).
    private static final String SALT = "40n50kuPl4y3r";
    private static final String CLIENT = "Aonsoku";
    private static final int TIMEOUT_MS = 15000;

    final String url;
    final String username;
    private final String password;
    private final boolean tokenAuth;
    private final String protocolVersion;

    private AonsokuServer(
        String url, String username, String password, boolean tokenAuth, String protocolVersion
    ) {
        this.url = url;
        this.username = username;
        this.password = password;
        this.tokenAuth = tokenAuth;
        this.protocolVersion = protocolVersion;
    }

    /** The server signed in to, or null when signed out. */
    @Nullable
    static AonsokuServer load(Context context) {
        SharedPreferences prefs = prefs(context);
        String url = prefs.getString("url", "");
        String username = prefs.getString("username", "");
        String password = prefs.getString("password", "");
        if (url.isEmpty() || username.isEmpty() || password.isEmpty()) return null;
        return new AonsokuServer(
            url,
            username,
            password,
            "token".equals(prefs.getString("authType", "token")),
            prefs.getString("protocolVersion", "1.16.0"));
    }

    static void save(
        Context context, String url, String username, String password, String authType,
        String protocolVersion
    ) {
        prefs(context).edit()
            .putString("url", trimSlash(url))
            .putString("username", username)
            .putString("password", password)
            .putString("authType", authType)
            .putString("protocolVersion", protocolVersion)
            .apply();
    }

    static void clear(Context context) {
        prefs(context).edit().clear().apply();
    }

    /** The URL of an API method, with the sign-in and these parameters. */
    String endpoint(String method, @Nullable Map<String, String> params) {
        Uri.Builder builder = Uri.parse(url + "/rest/" + method).buildUpon()
            .appendQueryParameter("u", username);
        if (tokenAuth) {
            builder.appendQueryParameter("t", password).appendQueryParameter("s", SALT);
        } else {
            builder.appendQueryParameter("p", password);
        }
        builder.appendQueryParameter("v", protocolVersion)
            .appendQueryParameter("c", CLIENT)
            .appendQueryParameter("f", "json");
        if (params != null) {
            for (Map.Entry<String, String> entry : params.entrySet()) {
                if (entry.getValue() != null) {
                    builder.appendQueryParameter(entry.getKey(), entry.getValue());
                }
            }
        }
        return builder.build().toString();
    }

    /** Streams a song, the way the web app does (see getSongStreamUrl). */
    String streamUrl(String songId, @Nullable String suffix) {
        // The web app has ALAC in .m4a transcoded (src/utils/alac.ts).
        String format = "m4a".equals(suffix) ? "opus" : suffix;
        return endpoint("stream", map(
            "id", songId,
            "format", format,
            "estimateContentLength", "true"));
    }

    String coverArtUrl(String coverArtId, int size) {
        return endpoint("getCoverArt", map("id", coverArtId, "size", String.valueOf(size)));
    }

    /**
     * Calls an API method and returns its "subsonic-response". Blocks: call
     * it off the main thread.
     */
    JSONObject call(String method, @Nullable Map<String, String> params) throws IOException {
        HttpURLConnection connection =
            (HttpURLConnection) new URL(endpoint(method, params)).openConnection();
        connection.setConnectTimeout(TIMEOUT_MS);
        connection.setReadTimeout(TIMEOUT_MS);
        try {
            int status = connection.getResponseCode();
            if (status != HttpURLConnection.HTTP_OK) {
                throw new IOException(method + ": HTTP " + status);
            }
            JSONObject response;
            try (InputStream in = connection.getInputStream()) {
                response = new JSONObject(readAll(in)).getJSONObject("subsonic-response");
            } catch (JSONException e) {
                throw new IOException(method + ": unexpected response", e);
            }
            if (!"ok".equals(response.optString("status"))) {
                JSONObject error = response.optJSONObject("error");
                int code = error != null ? error.optInt("code") : 0;
                String message = error != null ? error.optString("message") : "failed";
                throw new ServerException(code, method + ": " + message);
            }
            return response;
        } finally {
            connection.disconnect();
        }
    }

    /** The server refused the request; codes 40 and 41 are a bad sign-in. */
    static final class ServerException extends IOException {
        final int code;

        ServerException(int code, String message) {
            super(message);
            this.code = code;
        }

        boolean isSignIn() {
            return code == 40 || code == 41 || code == 44;
        }
    }

    /** Pairs of keys and values (null values are left out of URLs). */
    static Map<String, String> map(String... pairs) {
        Map<String, String> result = new java.util.LinkedHashMap<>();
        for (int i = 0; i + 1 < pairs.length; i += 2) result.put(pairs[i], pairs[i + 1]);
        return result;
    }

    private static SharedPreferences prefs(Context context) {
        return context.getApplicationContext()
            .getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    private static String trimSlash(String url) {
        String result = url == null ? "" : url.trim();
        while (result.endsWith("/")) result = result.substring(0, result.length() - 1);
        return result;
    }

    private static String readAll(InputStream in) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buffer = new byte[16384];
        int read;
        while ((read = in.read(buffer)) != -1) out.write(buffer, 0, read);
        return out.toString("UTF-8");
    }
}

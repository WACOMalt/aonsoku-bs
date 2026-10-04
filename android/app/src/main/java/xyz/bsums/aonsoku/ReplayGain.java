package xyz.bsums.aonsoku;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONObject;

/**
 * The listener's ReplayGain settings, handed over by the web app (see
 * NativePlayerPlugin.setReplayGain) and kept, so songs the car plays while
 * the app is closed are levelled as the app levels them
 * (src/utils/replayGain.ts).
 */
final class ReplayGain {

    private static final String PREFS = "aonsoku_replay_gain";

    private ReplayGain() {}

    static void save(
        Context context, boolean enabled, boolean album, float preAmp, float defaultGain
    ) {
        prefs(context).edit()
            .putBoolean("enabled", enabled)
            .putBoolean("album", album)
            .putFloat("preAmp", preAmp)
            .putFloat("defaultGain", defaultGain)
            .apply();
    }

    /** The linear gain for a song (Subsonic JSON); 1 when levelling is off. */
    static float gainFor(Context context, JSONObject song) {
        SharedPreferences prefs = prefs(context);
        if (!prefs.getBoolean("enabled", false)) return 1f;
        boolean album = prefs.getBoolean("album", false);
        double preAmp = prefs.getFloat("preAmp", 0f);
        double defaultGain = prefs.getFloat("defaultGain", 0f);

        double gain = defaultGain;
        double peak = 1;
        JSONObject values = song.optJSONObject("replayGain");
        if (values != null) {
            gain = values.optDouble(album ? "albumGain" : "trackGain", defaultGain);
            if (gain == 0 || Double.isNaN(gain)) gain = defaultGain;
            peak = values.optDouble(album ? "albumPeak" : "trackPeak", 1);
            if (Double.isNaN(peak)) peak = 1;
        }
        double result = Math.min(Math.pow(10, (gain + preAmp) / 20), 1 / peak);
        return Double.isFinite(result) && result > 0 ? (float) result : 1f;
    }

    private static SharedPreferences prefs(Context context) {
        return context.getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }
}

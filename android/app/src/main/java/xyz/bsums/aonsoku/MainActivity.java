package xyz.bsums.aonsoku;

import android.content.res.Configuration;
import android.os.Bundle;

import androidx.annotation.NonNull;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(NavigationBarPlugin.class);
        registerPlugin(MediaSessionPlugin.class);
        registerPlugin(NativePlayerPlugin.class);
        registerPlugin(AppUpdatePlugin.class);
        registerPlugin(MediaCachePlugin.class);
        // The song cache's download manager runs on the main thread.
        MediaCache.get(this);
        super.onCreate(savedInstanceState);

        // Gapless playback starts the next track on a second audio element
        // that the user never tapped. By default the WebView only lets an
        // element play after a tap on it, which blocks that handoff, most of
        // all with the screen off. This is a music player the user starts
        // themselves, so the per-element tap rule only gets in the way.
        getBridge().getWebView().getSettings().setMediaPlaybackRequiresUserGesture(false);
    }

    @Override
    public void onConfigurationChanged(@NonNull Configuration newConfig) {
        super.onConfigurationChanged(newConfig);

        // Rotating (or switching light/dark) re-applies the activity theme,
        // which repaints the window background and undoes the colour the
        // NavigationBar plugin set. Without this the theme's light default
        // shows as a pale border around the WebView wherever the system bars
        // inset it, which is most visible in landscape.
        NavigationBarPlugin.reapply(this);
    }
}

package xyz.bsums.aonsoku;

import android.app.Notification;
import android.app.PendingIntent;
import android.content.Intent;

import androidx.annotation.Nullable;
import androidx.annotation.OptIn;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.exoplayer.offline.Download;
import androidx.media3.exoplayer.offline.DownloadManager;
import androidx.media3.exoplayer.offline.DownloadNotificationHelper;
import androidx.media3.exoplayer.offline.DownloadService;
import androidx.media3.exoplayer.scheduler.PlatformScheduler;
import androidx.media3.exoplayer.scheduler.Scheduler;

import java.nio.charset.StandardCharsets;
import java.util.List;

/**
 * Downloads the songs the listener keeps cached (see MediaCache), in the
 * background with a progress notification. Waits for a network the
 * settings allow, and picks up again after a lost connection or a restart.
 */
@OptIn(markerClass = UnstableApi.class)
public class KeptDownloadService extends DownloadService {

    private static final String CHANNEL = "kept_songs";
    private static final int NOTIFICATION_ID = 7301;
    private static final int JOB_ID = 7302;

    private DownloadNotificationHelper notifications;

    public KeptDownloadService() {
        super(NOTIFICATION_ID, DEFAULT_FOREGROUND_NOTIFICATION_UPDATE_INTERVAL, CHANNEL,
            R.string.kept_channel_name, R.string.kept_channel_description);
    }

    @Override
    protected DownloadManager getDownloadManager() {
        return MediaCache.get(this).downloads();
    }

    @Nullable
    @Override
    protected Scheduler getScheduler() {
        // Starts the downloads again once the network allows, also when
        // the app isn't running.
        return new PlatformScheduler(this, JOB_ID);
    }

    @Override
    protected Notification getForegroundNotification(
            List<Download> downloads, int notMetRequirements) {
        if (notifications == null) notifications = new DownloadNotificationHelper(this, CHANNEL);
        String message = null;
        for (Download download : downloads) {
            if (download.state == Download.STATE_DOWNLOADING && download.request.data.length > 0) {
                message = new String(download.request.data, StandardCharsets.UTF_8);
                break;
            }
        }
        Intent open = getPackageManager().getLaunchIntentForPackage(getPackageName());
        PendingIntent content = open == null ? null : PendingIntent.getActivity(
            this, 0, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        return notifications.buildProgressNotification(
            this, R.drawable.ic_notification, content, message, downloads, notMetRequirements);
    }
}

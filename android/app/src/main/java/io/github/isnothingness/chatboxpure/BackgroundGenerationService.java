package io.github.isnothingness.chatboxpure;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.service.notification.StatusBarNotification;

import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;

import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Owns the foreground lifecycle for user-initiated model streams.
 *
 * Stream connections and replay buffers live in the process-scoped
 * {@link BackgroundStreamManager}. Starting work from this service keeps that owner independent
 * from the Activity/WebView and gives Android a user-visible reason to retain the process.
 */
public class BackgroundGenerationService extends Service {
    private static final String ACTION_START = "io.github.isnothingness.chatboxpure.GENERATION_START";
    private static final String ACTION_STOP = "io.github.isnothingness.chatboxpure.GENERATION_STOP";
    private static final String EXTRA_STREAM_ID = "streamId";
    private static final String EXTRA_TITLE = "title";
    private static final String EXTRA_BODY = "body";

    private static final String ACTIVE_CHANNEL_ID = "background_generation";
    private static final String LEGACY_COMPLETION_CHANNEL_ID = "generation_complete";
    private static final String SILENT_COMPLETION_CHANNEL_ID = "generation_complete_silent_v2";
    private static final String ALERT_COMPLETION_CHANNEL_ID = "generation_complete_alert_v2";
    private static final int ACTIVE_NOTIFICATION_ID = 41001;
    private static final int COMPLETION_NOTIFICATION_ID_BASE = 42000;
    private static final long GENERATION_WAKE_LOCK_TIMEOUT_MS = 60L * 60L * 1000L;
    private static volatile BackgroundGenerationService runningInstance;

    private final Set<String> activeStreams = ConcurrentHashMap.newKeySet();
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private String activeTitle = "ChatBox Pure";
    private String activeBody = "Generating a reply";
    private PowerManager.WakeLock generationWakeLock;

    public static void start(Context context, String streamId, String title, String body) {
        Intent intent = new Intent(context, BackgroundGenerationService.class)
            .setAction(ACTION_START)
            .putExtra(EXTRA_STREAM_ID, streamId)
            .putExtra(EXTRA_TITLE, title)
            .putExtra(EXTRA_BODY, body);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            context.startForegroundService(intent);
        } else {
            context.startService(intent);
        }
    }

    public static void stop(Context context, String streamId) {
        BackgroundGenerationService service = runningInstance;
        if (service != null) {
            service.mainHandler.post(() -> service.stopStream(streamId));
            return;
        }

        Intent intent = new Intent(context, BackgroundGenerationService.class)
            .setAction(ACTION_STOP)
            .putExtra(EXTRA_STREAM_ID, streamId);
        try {
            context.startService(intent);
        } catch (RuntimeException ignored) {
            // There is no running service to clean up. In particular, Android 12+
            // can reject a background start after the service has already stopped.
        }
    }

    public static void showCompletionNotification(Context context, String title, String body) {
        showCompletionNotification(context, null, null, title, body, "silent");
    }

    public static void showCompletionNotification(Context context, String title, String body, String mode) {
        showCompletionNotification(context, null, null, title, body, mode);
    }

    public static void showCompletionNotification(
        Context context,
        String streamId,
        String sessionId,
        String title,
        String body,
        String mode
    ) {
        configureNotificationChannels(context, mode);
        boolean silent = !"normal".equals(mode);
        String channelId = silent ? SILENT_COMPLETION_CHANNEL_ID : ALERT_COMPLETION_CHANNEL_ID;
        int notificationId = streamId == null
            ? COMPLETION_NOTIFICATION_ID_BASE
            : COMPLETION_NOTIFICATION_ID_BASE + (streamId.hashCode() & 0x0fff);
        NotificationManager manager = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        manager.notify(
            notificationId,
            new NotificationCompat.Builder(context, channelId)
                .setSmallIcon(android.R.drawable.stat_notify_chat)
                .setContentTitle(title)
                .setContentText(body)
                .setContentIntent(openAppIntent(context, notificationId, sessionId))
                .setAutoCancel(true)
                .setCategory(NotificationCompat.CATEGORY_MESSAGE)
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setSilent(silent)
                .setOnlyAlertOnce(true)
                .setDefaults(silent ? 0 : NotificationCompat.DEFAULT_ALL)
                .build()
        );
    }

    public static void clearCompletionNotifications(Context context) {
        NotificationManager manager = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        for (StatusBarNotification notification : manager.getActiveNotifications()) {
            int notificationId = notification.getId();
            if (
                notificationId >= COMPLETION_NOTIFICATION_ID_BASE &&
                notificationId <= COMPLETION_NOTIFICATION_ID_BASE + 0x0fff
            ) {
                manager.cancel(notificationId);
            }
        }
    }

    @Override
    public void onCreate() {
        super.onCreate();
        runningInstance = this;
        createActiveChannel(this);
        deleteChannel(this, LEGACY_COMPLETION_CHANNEL_ID);
        PowerManager powerManager = (PowerManager) getSystemService(Context.POWER_SERVICE);
        generationWakeLock = powerManager.newWakeLock(
            PowerManager.PARTIAL_WAKE_LOCK,
            getPackageName() + ":background-generation"
        );
        generationWakeLock.setReferenceCounted(false);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent == null || intent.getAction() == null) {
            stopIfIdle();
            return START_NOT_STICKY;
        }

        String streamId = intent.getStringExtra(EXTRA_STREAM_ID);
        if (ACTION_START.equals(intent.getAction()) && streamId != null) {
            activeStreams.add(streamId);
            activeTitle = valueOrDefault(intent.getStringExtra(EXTRA_TITLE), activeTitle);
            activeBody = valueOrDefault(intent.getStringExtra(EXTRA_BODY), activeBody);
            startForeground(ACTIVE_NOTIFICATION_ID, buildActiveNotification());
            acquireGenerationWakeLock();
            if (!BackgroundStreamManager.getInstance(this).startTask(streamId)) {
                stopStream(streamId);
            }
        } else if (ACTION_STOP.equals(intent.getAction()) && streamId != null) {
            stopStream(streamId);
        }

        return START_NOT_STICKY;
    }

    private Notification buildActiveNotification() {
        return new NotificationCompat.Builder(this, ACTIVE_CHANNEL_ID)
            .setSmallIcon(android.R.drawable.stat_notify_sync_noanim)
            .setContentTitle(activeTitle)
            .setContentText(activeBody)
            .setContentIntent(openAppIntent(this, ACTIVE_NOTIFICATION_ID))
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setSilent(true)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .build();
    }

    private void stopIfIdle() {
        if (activeStreams.isEmpty()) {
            releaseGenerationWakeLock();
            stopSelf();
        }
    }

    private void stopStream(String streamId) {
        activeStreams.remove(streamId);
        if (activeStreams.isEmpty()) {
            releaseGenerationWakeLock();
            stopForeground(true);
            stopSelf();
        } else {
            NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            manager.notify(ACTIVE_NOTIFICATION_ID, buildActiveNotification());
        }
    }

    private void acquireGenerationWakeLock() {
        if (generationWakeLock != null && !generationWakeLock.isHeld()) {
            // A model response should finish well within this safety ceiling. Normal
            // completion releases the lock immediately; the timeout prevents a leak
            // if the process encounters an unexpected lifecycle failure.
            generationWakeLock.acquire(GENERATION_WAKE_LOCK_TIMEOUT_MS);
        }
    }

    private void releaseGenerationWakeLock() {
        if (generationWakeLock != null && generationWakeLock.isHeld()) {
            generationWakeLock.release();
        }
    }

    @Override
    public void onDestroy() {
        if (runningInstance == this) {
            runningInstance = null;
        }
        releaseGenerationWakeLock();
        super.onDestroy();
    }

    private static PendingIntent openAppIntent(Context context, int requestCode) {
        return openAppIntent(context, requestCode, null);
    }

    private static PendingIntent openAppIntent(
        Context context,
        int requestCode,
        String sessionId
    ) {
        Intent launchIntent = new Intent(context, MainActivity.class)
            .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        if (sessionId != null && !sessionId.isEmpty()) {
            launchIntent.setAction(Intent.ACTION_VIEW);
            launchIntent.setData(
                new Uri.Builder()
                    .scheme("chatbox-pure")
                    .authority("session")
                    .appendPath(sessionId)
                    .build()
            );
        }
        return PendingIntent.getActivity(
            context,
            requestCode,
            launchIntent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
    }

    public static void configureNotificationChannels(Context context, String mode) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;

        createActiveChannel(context);
        NotificationManager manager = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        manager.deleteNotificationChannel(LEGACY_COMPLETION_CHANNEL_ID);

        if ("normal".equals(mode)) {
            manager.deleteNotificationChannel(SILENT_COMPLETION_CHANNEL_ID);
            createAlertCompletionChannel(context, manager);
        } else if ("silent".equals(mode)) {
            manager.deleteNotificationChannel(ALERT_COMPLETION_CHANNEL_ID);
            createSilentCompletionChannel(context, manager);
        } else {
            manager.deleteNotificationChannel(SILENT_COMPLETION_CHANNEL_ID);
            manager.deleteNotificationChannel(ALERT_COMPLETION_CHANNEL_ID);
        }
    }

    private static void createActiveChannel(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;

        NotificationManager manager = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        NotificationChannel activeChannel = new NotificationChannel(
            ACTIVE_CHANNEL_ID,
            context.getString(R.string.background_generation_channel),
            NotificationManager.IMPORTANCE_LOW
        );
        activeChannel.setDescription(context.getString(R.string.background_generation_channel_description));
        activeChannel.setSound(null, null);
        manager.createNotificationChannel(activeChannel);
    }

    private static void createSilentCompletionChannel(Context context, NotificationManager manager) {
        NotificationChannel silentCompletionChannel = new NotificationChannel(
            SILENT_COMPLETION_CHANNEL_ID,
            context.getString(R.string.generation_complete_silent_channel),
            NotificationManager.IMPORTANCE_HIGH
        );
        silentCompletionChannel.setDescription(
            context.getString(R.string.generation_complete_silent_channel_description)
        );
        silentCompletionChannel.setSound(null, null);
        silentCompletionChannel.enableVibration(false);
        manager.createNotificationChannel(silentCompletionChannel);
    }

    private static void createAlertCompletionChannel(Context context, NotificationManager manager) {
        NotificationChannel alertCompletionChannel = new NotificationChannel(
            ALERT_COMPLETION_CHANNEL_ID,
            context.getString(R.string.generation_complete_alert_channel),
            NotificationManager.IMPORTANCE_HIGH
        );
        alertCompletionChannel.setDescription(
            context.getString(R.string.generation_complete_alert_channel_description)
        );
        alertCompletionChannel.enableVibration(true);
        manager.createNotificationChannel(alertCompletionChannel);
    }

    private static void deleteChannel(Context context, String channelId) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager manager = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        manager.deleteNotificationChannel(channelId);
    }

    private static String valueOrDefault(String value, String fallback) {
        return value == null || value.isEmpty() ? fallback : value;
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}

package io.github.isnothingness.chatboxpure;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.IBinder;

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
    private static final String COMPLETION_CHANNEL_ID = "generation_complete";
    private static final int ACTIVE_NOTIFICATION_ID = 41001;
    private static final int COMPLETION_NOTIFICATION_ID = 41002;

    private final Set<String> activeStreams = ConcurrentHashMap.newKeySet();
    private String activeTitle = "ChatBox Pure";
    private String activeBody = "Generating a reply";

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
        Intent intent = new Intent(context, BackgroundGenerationService.class)
            .setAction(ACTION_STOP)
            .putExtra(EXTRA_STREAM_ID, streamId);
        context.startService(intent);
    }

    public static void showCompletionNotification(Context context, String title, String body) {
        createChannels(context);
        NotificationManager manager = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        manager.notify(
            COMPLETION_NOTIFICATION_ID,
            new NotificationCompat.Builder(context, COMPLETION_CHANNEL_ID)
                .setSmallIcon(android.R.drawable.stat_notify_chat)
                .setContentTitle(title)
                .setContentText(body)
                .setContentIntent(openAppIntent(context))
                .setAutoCancel(true)
                .setCategory(NotificationCompat.CATEGORY_MESSAGE)
                .setPriority(NotificationCompat.PRIORITY_DEFAULT)
                .build()
        );
    }

    @Override
    public void onCreate() {
        super.onCreate();
        createChannels(this);
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
            BackgroundStreamManager.getInstance(this).startTask(streamId);
        } else if (ACTION_STOP.equals(intent.getAction()) && streamId != null) {
            activeStreams.remove(streamId);
            if (activeStreams.isEmpty()) {
                stopForeground(true);
                stopSelf();
            } else {
                NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
                manager.notify(ACTIVE_NOTIFICATION_ID, buildActiveNotification());
            }
        }

        return START_NOT_STICKY;
    }

    private Notification buildActiveNotification() {
        return new NotificationCompat.Builder(this, ACTIVE_CHANNEL_ID)
            .setSmallIcon(android.R.drawable.stat_notify_sync_noanim)
            .setContentTitle(activeTitle)
            .setContentText(activeBody)
            .setContentIntent(openAppIntent(this))
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setSilent(true)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build();
    }

    private void stopIfIdle() {
        if (activeStreams.isEmpty()) {
            stopSelf();
        }
    }

    private static PendingIntent openAppIntent(Context context) {
        Intent launchIntent = new Intent(context, MainActivity.class)
            .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        return PendingIntent.getActivity(
            context,
            0,
            launchIntent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
    }

    private static void createChannels(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;

        NotificationManager manager = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        NotificationChannel activeChannel = new NotificationChannel(
            ACTIVE_CHANNEL_ID,
            context.getString(R.string.background_generation_channel),
            NotificationManager.IMPORTANCE_LOW
        );
        activeChannel.setDescription(context.getString(R.string.background_generation_channel_description));
        activeChannel.setSound(null, null);

        NotificationChannel completionChannel = new NotificationChannel(
            COMPLETION_CHANNEL_ID,
            context.getString(R.string.generation_complete_channel),
            NotificationManager.IMPORTANCE_DEFAULT
        );
        completionChannel.setDescription(context.getString(R.string.generation_complete_channel_description));

        manager.createNotificationChannel(activeChannel);
        manager.createNotificationChannel(completionChannel);
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

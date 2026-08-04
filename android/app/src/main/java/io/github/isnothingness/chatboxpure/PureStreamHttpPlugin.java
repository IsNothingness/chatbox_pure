package io.github.isnothingness.chatboxpure;

import android.Manifest;
import android.os.Build;
import android.util.Base64;
import android.util.Log;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.util.HashMap;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.util.UUID;

@CapacitorPlugin(
    name = "PureStreamHttp",
    permissions = {
        @Permission(strings = { Manifest.permission.POST_NOTIFICATIONS }, alias = "notifications")
    }
)
public class PureStreamHttpPlugin extends Plugin {
    private static final String TAG = "PureStreamHttp";

    private final BackgroundStreamManager.Observer observer = new BackgroundStreamManager.Observer() {
        @Override
        public void onChunk(String id, long sequence, byte[] chunk) {
            JSObject data = new JSObject();
            data.put("id", id);
            data.put("sequence", sequence);
            data.put("chunkBase64", Base64.encodeToString(chunk, Base64.NO_WRAP));
            notifyListeners("chunk", data);
        }

        @Override
        public void onEnd(String id, long lastSequence) {
            JSObject data = new JSObject();
            data.put("id", id);
            data.put("lastSequence", lastSequence);
            notifyListeners("end", data);
        }

        @Override
        public void onError(String id, long lastSequence, String error) {
            JSObject data = new JSObject();
            data.put("id", id);
            data.put("lastSequence", lastSequence);
            data.put("error", error);
            notifyListeners("error", data);
        }
    };

    @Override
    public void load() {
        BackgroundStreamManager.getInstance(getContext()).addObserver(observer);
    }

    @PluginMethod
    public void startStream(PluginCall call) {
        String urlString = call.getString("url");
        String method = call.getString("method", "GET");
        JSObject headersObject = call.getObject("headers", new JSObject());
        String body = call.getString("body");
        boolean keepAlive = Boolean.TRUE.equals(call.getBoolean("keepAlive", false));
        boolean notifyWhenComplete = Boolean.TRUE.equals(call.getBoolean("notifyWhenComplete", false));
        String completionNotificationMode = call.getString(
            "completionNotificationMode",
            notifyWhenComplete ? "silent" : "off"
        );
        String notificationTitle = call.getString("notificationTitle", "ChatBox Pure");
        String notificationBody = call.getString("notificationBody", "Generating a reply");
        String completionTitle = call.getString("completionTitle", "Reply generated");
        String completionBody = call.getString("completionBody", "Tap to return to ChatBox Pure and view the reply.");
        String requestedId = call.getString("id");
        String streamId = requestedId == null || requestedId.isEmpty() ? UUID.randomUUID().toString() : requestedId;
        String clientRequestId = call.getString("clientRequestId");
        String sessionId = call.getString("sessionId");
        String messageId = call.getString("messageId");

        if (urlString == null) {
            call.reject("URL is required");
            return;
        }

        BackgroundGenerationService.configureNotificationChannels(getContext(), completionNotificationMode);

        Map<String, String> headers = new HashMap<>();
        Iterator<String> keys = headersObject.keys();
        while (keys.hasNext()) {
            String key = keys.next();
            String value = headersObject.getString(key);
            if (value != null) {
                headers.put(key, value);
            }
        }

        BackgroundStreamManager manager = BackgroundStreamManager.getInstance(getContext());
        boolean created = manager.createTask(
            streamId,
            clientRequestId,
            sessionId,
            messageId,
            keepAlive,
            completionNotificationMode,
            completionTitle,
            completionBody,
            new BackgroundStreamManager.StreamRequest(urlString, method, headers, body)
        );
        if (!created) {
            call.reject("A stream with this ID already exists");
            return;
        }

        if (keepAlive) {
            try {
                BackgroundGenerationService.start(
                    getContext(),
                    streamId,
                    notificationTitle,
                    notificationBody
                );
            } catch (RuntimeException error) {
                // Preserve foreground behavior if Android refuses foreground-service startup.
                Log.w(TAG, "Could not start foreground generation service", error);
                manager.startTask(streamId);
            }
        } else {
            manager.startTask(streamId);
        }

        JSObject result = new JSObject();
        result.put("id", streamId);
        call.resolve(result);
    }

    @PluginMethod
    public void attachStream(PluginCall call) {
        String streamId = call.getString("id");
        long afterSequence = call.getLong("afterSequence", -1L);
        int maxChunks = Math.max(1, Math.min(512, call.getInt("maxChunks", 128)));
        int maxBytes = Math.max(32 * 1024, Math.min(1024 * 1024, call.getInt("maxBytes", 256 * 1024)));
        if (streamId == null) {
            call.reject("Stream ID is required");
            return;
        }

        BackgroundStreamManager.StreamSnapshot snapshot =
            BackgroundStreamManager.getInstance(getContext()).snapshot(
                streamId,
                afterSequence,
                maxChunks,
                maxBytes
            );
        if (snapshot == null) {
            call.reject("Stream not found");
            return;
        }
        call.resolve(snapshotToJs(snapshot, true));
    }

    @PluginMethod
    public void listStreams(PluginCall call) {
        List<BackgroundStreamManager.StreamSnapshot> snapshots =
            BackgroundStreamManager.getInstance(getContext()).listTasks();
        JSArray streams = new JSArray();
        for (BackgroundStreamManager.StreamSnapshot snapshot : snapshots) {
            streams.put(snapshotToJs(snapshot, false));
        }
        JSObject result = new JSObject();
        result.put("streams", streams);
        call.resolve(result);
    }

    @PluginMethod
    public void acknowledgeStream(PluginCall call) {
        String streamId = call.getString("id");
        if (streamId == null) {
            call.reject("Stream ID is required");
            return;
        }
        BackgroundStreamManager.getInstance(getContext()).acknowledge(streamId);
        call.resolve();
    }

    @PluginMethod
    public void cancelStream(PluginCall call) {
        String streamId = call.getString("id");
        if (streamId == null) {
            call.reject("Stream ID is required");
            return;
        }
        BackgroundStreamManager.getInstance(getContext()).cancel(streamId);
        call.resolve();
    }

    @PluginMethod
    public void requestNotificationPermission(PluginCall call) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
            resolvePermission(call, true);
            return;
        }
        if (getPermissionState("notifications") == PermissionState.GRANTED) {
            resolvePermission(call, true);
            return;
        }
        requestPermissionForAlias("notifications", call, "notificationPermissionCallback");
    }

    @PluginMethod
    public void configureNotificationChannels(PluginCall call) {
        String mode = call.getString("mode", "off");
        BackgroundGenerationService.configureNotificationChannels(getContext(), mode);
        call.resolve();
    }

    @PermissionCallback
    private void notificationPermissionCallback(PluginCall call) {
        resolvePermission(call, getPermissionState("notifications") == PermissionState.GRANTED);
    }

    private void resolvePermission(PluginCall call, boolean granted) {
        JSObject result = new JSObject();
        result.put("granted", granted);
        call.resolve(result);
    }

    @PluginMethod
    public void showCompletionNotification(PluginCall call) {
        String title = call.getString("title", "ChatBox Pure");
        String body = call.getString("body", "Reply generated");
        String mode = call.getString("mode", "silent");
        BackgroundGenerationService.showCompletionNotification(getContext(), title, body, mode);
        call.resolve();
    }

    @Override
    protected void handleOnDestroy() {
        BackgroundStreamManager.getInstance(getContext()).removeObserver(observer);
        super.handleOnDestroy();
    }

    private static JSObject snapshotToJs(
        BackgroundStreamManager.StreamSnapshot snapshot,
        boolean includeChunks
    ) {
        JSObject result = new JSObject();
        result.put("id", snapshot.id);
        result.put("clientRequestId", snapshot.clientRequestId);
        result.put("sessionId", snapshot.sessionId);
        result.put("messageId", snapshot.messageId);
        result.put("state", snapshot.state);
        result.put("error", snapshot.error);
        result.put("lastSequence", snapshot.lastSequence);
        result.put("createdAt", snapshot.createdAt);
        result.put("hasMore", snapshot.hasMore);
        if (includeChunks) {
            JSArray chunks = new JSArray();
            for (BackgroundStreamManager.ChunkRecord record : snapshot.chunks) {
                JSObject chunk = new JSObject();
                chunk.put("sequence", record.sequence);
                chunk.put("chunkBase64", Base64.encodeToString(record.chunk, Base64.NO_WRAP));
                chunks.put(chunk);
            }
            result.put("chunks", chunks);
        }
        return result;
    }
}

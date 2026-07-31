package io.github.isnothingness.chatboxpure;

import android.Manifest;
import android.os.Build;
import android.util.Log;

import com.chatbox.plugins.streamhttp.SSEParser;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Iterator;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

@CapacitorPlugin(
    name = "PureStreamHttp",
    permissions = {
        @Permission(strings = { Manifest.permission.POST_NOTIFICATIONS }, alias = "notifications")
    }
)
public class PureStreamHttpPlugin extends Plugin {
    private static final String TAG = "PureStreamHttp";
    private final Map<String, HttpURLConnection> activeConnections = new HashMap<>();
    private final Map<String, Thread> activeThreads = new HashMap<>();
    private final ExecutorService executor = Executors.newCachedThreadPool();

    @PluginMethod
    public void startStream(PluginCall call) {
        String urlString = call.getString("url");
        String method = call.getString("method", "GET");
        JSObject headers = call.getObject("headers", new JSObject());
        String body = call.getString("body");
        boolean keepAlive = Boolean.TRUE.equals(call.getBoolean("keepAlive", false));
        String notificationTitle = call.getString("notificationTitle", "ChatBox Pure");
        String notificationBody = call.getString("notificationBody", "Generating a reply");

        if (urlString == null) {
            call.reject("URL is required");
            return;
        }

        String streamId = UUID.randomUUID().toString();
        if (keepAlive) {
            try {
                BackgroundGenerationService.start(
                    getContext(),
                    streamId,
                    notificationTitle,
                    notificationBody
                );
            } catch (RuntimeException error) {
                // The request should still work in the foreground if the OS refuses service startup.
                Log.w(TAG, "Could not start foreground generation service", error);
            }
        }

        executor.execute(() -> runStream(
            streamId,
            urlString,
            method,
            headers,
            body,
            keepAlive
        ));

        JSObject result = new JSObject();
        result.put("id", streamId);
        call.resolve(result);
    }

    private void runStream(
        String streamId,
        String urlString,
        String method,
        JSObject headers,
        String body,
        boolean keepAlive
    ) {
        try {
            URL url = new URL(urlString);
            HttpURLConnection connection = (HttpURLConnection) url.openConnection();

            synchronized (activeConnections) {
                activeConnections.put(streamId, connection);
                activeThreads.put(streamId, Thread.currentThread());
            }

            connection.setRequestMethod(method);
            Iterator<String> keys = headers.keys();
            while (keys.hasNext()) {
                String key = keys.next();
                String value = headers.getString(key);
                if (value != null) {
                    connection.setRequestProperty(key, value);
                }
            }

            connection.setConnectTimeout(30_000);
            // SSE responses can legitimately remain silent while a model is thinking.
            // A zero read timeout means no artificial timeout; cancellation still disconnects.
            connection.setReadTimeout(0);
            connection.setChunkedStreamingMode(0);

            if (body != null && !body.isEmpty() && !"GET".equals(method)) {
                connection.setDoOutput(true);
                try (OutputStream output = connection.getOutputStream()) {
                    byte[] input = body.getBytes(StandardCharsets.UTF_8);
                    output.write(input);
                }
            }

            int responseCode = connection.getResponseCode();
            InputStream inputStream = responseCode >= 200 && responseCode < 300
                ? connection.getInputStream()
                : connection.getErrorStream();

            if (inputStream != null) {
                readEvents(streamId, inputStream);
            }

            if (isActive(streamId)) {
                JSObject endData = new JSObject();
                endData.put("id", streamId);
                notifyListeners("end", endData);
            }
        } catch (IOException error) {
            if (isActive(streamId)) {
                Log.e(TAG, "Stream error: " + error.getMessage(), error);
                JSObject errorData = new JSObject();
                errorData.put("id", streamId);
                errorData.put("error", error.getMessage());
                notifyListeners("error", errorData);
            }
        } finally {
            synchronized (activeConnections) {
                HttpURLConnection connection = activeConnections.remove(streamId);
                if (connection != null) {
                    connection.disconnect();
                }
                activeThreads.remove(streamId);
            }
            if (keepAlive) {
                try {
                    BackgroundGenerationService.stop(getContext(), streamId);
                } catch (RuntimeException error) {
                    Log.w(TAG, "Could not stop foreground generation service", error);
                }
            }
        }
    }

    private void readEvents(String streamId, InputStream inputStream) throws IOException {
        try (BufferedReader reader = new BufferedReader(
            new InputStreamReader(inputStream, StandardCharsets.UTF_8)
        )) {
            SSEParser parser = new SSEParser();
            String line;
            while ((line = reader.readLine()) != null) {
                if (!isActive(streamId)) break;
                emitChunk(streamId, parser.processLine(line));
            }
            emitChunk(streamId, parser.processLine(""));
            emitChunk(streamId, parser.flush());
        }
    }

    private void emitChunk(String streamId, String chunk) {
        if (chunk == null || chunk.isEmpty() || !isActive(streamId)) return;
        JSObject data = new JSObject();
        data.put("id", streamId);
        data.put("chunk", chunk);
        notifyListeners("chunk", data);
    }

    private boolean isActive(String streamId) {
        synchronized (activeConnections) {
            return activeConnections.containsKey(streamId);
        }
    }

    @PluginMethod
    public void cancelStream(PluginCall call) {
        String streamId = call.getString("id");
        if (streamId == null) {
            call.reject("Stream ID is required");
            return;
        }

        synchronized (activeConnections) {
            HttpURLConnection connection = activeConnections.remove(streamId);
            if (connection != null) {
                connection.disconnect();
            }
            Thread thread = activeThreads.remove(streamId);
            if (thread != null) {
                thread.interrupt();
            }
        }
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
        BackgroundGenerationService.showCompletionNotification(getContext(), title, body);
        call.resolve();
    }

    @Override
    protected void handleOnDestroy() {
        // Running requests are intentionally allowed to finish while the foreground
        // service keeps the process alive. shutdown() rejects new work but does not
        // interrupt already-running tasks.
        executor.shutdown();
        super.handleOnDestroy();
    }
}

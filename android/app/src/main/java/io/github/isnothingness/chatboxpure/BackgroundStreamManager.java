package io.github.isnothingness.chatboxpure;

import android.content.Context;
import android.util.Log;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Process-scoped owner for model response streams.
 *
 * Capacitor plugin instances are tied to a WebView and may be destroyed while a foreground
 * generation is still running. This manager is owned by the application process and is driven
 * by {@link BackgroundGenerationService}, so the connection and buffered chunks outlive an
 * Activity/WebView instance.
 */
final class BackgroundStreamManager {
    private static final String TAG = "BackgroundStream";
    static final String STATE_PENDING = "pending";
    static final String STATE_RUNNING = "running";
    static final String STATE_ENDED = "ended";
    static final String STATE_ERROR = "error";
    static final String STATE_CANCELLED = "cancelled";

    private static final int MAX_BUFFERED_BYTES = 32 * 1024 * 1024;
    private static final long TERMINAL_RETENTION_MS = 60L * 60L * 1000L;
    private static volatile BackgroundStreamManager instance;

    static final class StreamRequest {
        final String url;
        final String method;
        final Map<String, String> headers;
        final String body;

        StreamRequest(String url, String method, Map<String, String> headers, String body) {
            this.url = url;
            this.method = method;
            this.headers = Collections.unmodifiableMap(new HashMap<>(headers));
            this.body = body;
        }
    }

    static final class ChunkRecord {
        final long sequence;
        final byte[] chunk;

        ChunkRecord(long sequence, byte[] chunk) {
            this.sequence = sequence;
            this.chunk = chunk;
        }
    }

    static final class StreamSnapshot {
        final String id;
        final String clientRequestId;
        final String sessionId;
        final String messageId;
        final String state;
        final String error;
        final long lastSequence;
        final long createdAt;
        final List<ChunkRecord> chunks;
        final boolean hasMore;

        StreamSnapshot(
            String id,
            String clientRequestId,
            String sessionId,
            String messageId,
            String state,
            String error,
            long lastSequence,
            long createdAt,
            List<ChunkRecord> chunks,
            boolean hasMore
        ) {
            this.id = id;
            this.clientRequestId = clientRequestId;
            this.sessionId = sessionId;
            this.messageId = messageId;
            this.state = state;
            this.error = error;
            this.lastSequence = lastSequence;
            this.createdAt = createdAt;
            this.chunks = chunks;
            this.hasMore = hasMore;
        }
    }

    private static final class StreamTask {
        final String id;
        final String clientRequestId;
        final String sessionId;
        final String messageId;
        final boolean keepAlive;
        final String completionNotificationMode;
        final String completionTitle;
        final String completionBody;
        final long createdAt;
        final Object lock = new Object();
        final List<ChunkRecord> chunks = new ArrayList<>();

        StreamRequest request;
        HttpURLConnection connection;
        Thread workerThread;
        String state = STATE_PENDING;
        String error;
        long nextSequence;
        long terminalAt;
        int bufferedBytes;
        boolean started;
        boolean removed;
        boolean completionNotified;
        long lastSnapshotAfterSequence = Long.MIN_VALUE;
        int repeatedSnapshotCount;
        long lastSnapshotLogAt;
        long lastProgressLogAt;

        StreamTask(
            String id,
            String clientRequestId,
            String sessionId,
            String messageId,
            boolean keepAlive,
            String completionNotificationMode,
            String completionTitle,
            String completionBody,
            StreamRequest request
        ) {
            this(
                id,
                clientRequestId,
                sessionId,
                messageId,
                keepAlive,
                completionNotificationMode,
                completionTitle,
                completionBody,
                request,
                System.currentTimeMillis()
            );
        }

        StreamTask(
            String id,
            String clientRequestId,
            String sessionId,
            String messageId,
            boolean keepAlive,
            String completionNotificationMode,
            String completionTitle,
            String completionBody,
            StreamRequest request,
            long createdAt
        ) {
            this.id = id;
            this.clientRequestId = clientRequestId;
            this.sessionId = sessionId;
            this.messageId = messageId;
            this.keepAlive = keepAlive;
            this.completionNotificationMode = completionNotificationMode;
            this.completionTitle = completionTitle;
            this.completionBody = completionBody;
            this.request = request;
            this.createdAt = createdAt;
        }
    }

    private final Context appContext;
    private final Map<String, StreamTask> tasks = new ConcurrentHashMap<>();
    private final ExecutorService executor = Executors.newCachedThreadPool();

    private BackgroundStreamManager(Context context) {
        appContext = context.getApplicationContext();
        GenerationDebugLog.event(appContext, "debug_log_started");
    }

    static BackgroundStreamManager getInstance(Context context) {
        BackgroundStreamManager current = instance;
        if (current != null) {
            return current;
        }
        synchronized (BackgroundStreamManager.class) {
            if (instance == null) {
                instance = new BackgroundStreamManager(context);
            }
            return instance;
        }
    }

    boolean createTask(
        String id,
        String clientRequestId,
        String sessionId,
        String messageId,
        boolean keepAlive,
        String completionNotificationMode,
        String completionTitle,
        String completionBody,
        StreamRequest request
    ) {
        cleanupExpiredTasks();
        StreamTask task = new StreamTask(
            id,
            clientRequestId,
            sessionId,
            messageId,
            keepAlive,
            completionNotificationMode,
            completionTitle,
            completionBody,
            request
        );
        boolean created = tasks.putIfAbsent(id, task) == null;
        if (created) {
            Map<String, Object> fields = new HashMap<>();
            fields.put("streamId", task.id);
            fields.put("sessionId", task.sessionId);
            fields.put("messageId", task.messageId);
            fields.put("keepAlive", task.keepAlive);
            GenerationDebugLog.event(appContext, "stream_created", fields);
        }
        return created;
    }

    boolean startTask(String id) {
        StreamTask task = tasks.get(id);
        if (task == null) {
            return false;
        }
        synchronized (task.lock) {
            if (task.started) {
                return STATE_RUNNING.equals(task.state);
            }
            if (task.request == null) {
                return false;
            }
            task.started = true;
            task.state = STATE_RUNNING;
        }
        Map<String, Object> fields = new HashMap<>();
        fields.put("streamId", task.id);
        fields.put("state", task.state);
        GenerationDebugLog.event(appContext, "stream_started", fields);
        executor.execute(() -> runTask(task));
        return true;
    }

    StreamSnapshot snapshot(String id, long afterSequence, int maxChunks, int maxBytes) {
        StreamTask task = tasks.get(id);
        return task == null ? null : snapshotTask(task, afterSequence, maxChunks, maxBytes);
    }

    List<StreamSnapshot> listTasks() {
        cleanupExpiredTasks();
        List<StreamSnapshot> snapshots = new ArrayList<>();
        for (StreamTask task : tasks.values()) {
            snapshots.add(snapshotTask(task, Long.MAX_VALUE, 0, 0));
        }
        return snapshots;
    }

    void acknowledge(String id) {
        StreamTask task = tasks.get(id);
        if (task == null) {
            return;
        }
        synchronized (task.lock) {
            if (!isTerminal(task.state)) {
                return;
            }
            task.removed = true;
        }
        tasks.remove(id, task);
        Map<String, Object> fields = new HashMap<>();
        fields.put("streamId", task.id);
        fields.put("state", task.state);
        fields.put("totalBytes", task.bufferedBytes);
        GenerationDebugLog.event(appContext, "stream_acknowledged", fields);
    }

    void cancel(String id) {
        StreamTask task = tasks.get(id);
        if (task == null) {
            return;
        }
        HttpURLConnection connection;
        Thread workerThread;
        synchronized (task.lock) {
            if (isTerminal(task.state)) {
                return;
            }
            connection = task.connection;
            workerThread = task.workerThread;
            task.request = null;
            task.connection = null;
            task.workerThread = null;
            task.error = "Cancelled";
            task.state = STATE_CANCELLED;
            task.terminalAt = System.currentTimeMillis();
        }
        Map<String, Object> cancelFields = new HashMap<>();
        cancelFields.put("streamId", task.id);
        cancelFields.put("lastSequence", task.nextSequence - 1);
        cancelFields.put("totalBytes", task.bufferedBytes);
        GenerationDebugLog.event(appContext, "cancel_requested", cancelFields);
        if (connection != null) {
            connection.disconnect();
        }
        if (workerThread != null) {
            workerThread.interrupt();
        }
        if (task.keepAlive) {
            BackgroundGenerationService.stop(appContext, id);
        }
        logSealed(task);
    }

    private void runTask(StreamTask task) {
        StreamRequest request;
        synchronized (task.lock) {
            request = task.request;
            task.workerThread = Thread.currentThread();
        }
        if (request == null) {
            failTask(task, new IOException("Stream request is unavailable"));
            finishTask(task);
            return;
        }

        try {
            URL url = new URL(request.url);
            HttpURLConnection connection = (HttpURLConnection) url.openConnection();
            synchronized (task.lock) {
                task.connection = connection;
            }

            connection.setRequestMethod(request.method);
            for (Map.Entry<String, String> header : request.headers.entrySet()) {
                connection.setRequestProperty(header.getKey(), header.getValue());
            }
            connection.setConnectTimeout(30_000);
            // Model streams can remain silent while reasoning. Cancellation still disconnects.
            connection.setReadTimeout(0);
            connection.setUseCaches(false);
            connection.setDoInput(true);

            if (
                request.body != null &&
                !request.body.isEmpty() &&
                !"GET".equalsIgnoreCase(request.method)
            ) {
                byte[] requestBody = request.body.getBytes(StandardCharsets.UTF_8);
                connection.setDoOutput(true);
                // Sending a fixed-length JSON body avoids gateway incompatibilities with
                // chunked request uploads. The response itself remains streamed.
                connection.setFixedLengthStreamingMode(requestBody.length);
                try (OutputStream output = connection.getOutputStream()) {
                    output.write(requestBody);
                }
            }

            int responseCode = connection.getResponseCode();
            boolean successful = responseCode >= 200 && responseCode < 300;
            InputStream inputStream = successful ? connection.getInputStream() : connection.getErrorStream();
            if (!successful) {
                String detail = inputStream == null ? "" : readErrorBody(inputStream);
                throw new IOException(
                    "HTTP " + responseCode + (detail.isEmpty() ? "" : ": " + detail)
                );
            }
            if (inputStream != null) {
                readResponseBytes(task, inputStream);
            }
            if (isRunning(task)) {
                endTask(task);
            }
        } catch (IOException error) {
            Log.e(TAG, "Stream " + task.id + " failed", error);
            if (isRunning(task)) {
                failTask(task, error);
            }
        } finally {
            finishTask(task);
        }
    }

    private String readErrorBody(InputStream inputStream) throws IOException {
        StringBuilder body = new StringBuilder();
        try (BufferedReader reader = new BufferedReader(
            new InputStreamReader(inputStream, StandardCharsets.UTF_8)
        )) {
            char[] buffer = new char[2048];
            int count;
            while (body.length() < 8192 && (count = reader.read(buffer)) != -1) {
                body.append(buffer, 0, Math.min(count, 8192 - body.length()));
            }
        }
        return body.toString().trim();
    }

    private void readResponseBytes(StreamTask task, InputStream inputStream) throws IOException {
        try (InputStream stream = inputStream) {
            byte[] buffer = new byte[16 * 1024];
            int count;
            while ((count = stream.read(buffer)) != -1) {
                if (!isRunning(task)) {
                    break;
                }
                byte[] chunk = new byte[count];
                System.arraycopy(buffer, 0, chunk, 0, count);
                appendChunk(task, chunk);
            }
        }
    }

    private void appendChunk(StreamTask task, byte[] chunk) throws IOException {
        if (chunk == null || chunk.length == 0) {
            return;
        }
        long sequence;
        int chunkBytes = chunk.length;
        synchronized (task.lock) {
            if (!STATE_RUNNING.equals(task.state)) {
                return;
            }
            if (task.bufferedBytes + chunkBytes > MAX_BUFFERED_BYTES) {
                throw new IOException("Background response exceeded the 32 MB safety buffer");
            }
            sequence = task.nextSequence++;
            task.bufferedBytes += chunkBytes;
            task.chunks.add(new ChunkRecord(sequence, chunk));
        }
        long now = System.currentTimeMillis();
        if (sequence == 0 || sequence % 64 == 0 || now - task.lastProgressLogAt >= 5000L) {
            task.lastProgressLogAt = now;
            Map<String, Object> fields = new HashMap<>();
            fields.put("streamId", task.id);
            fields.put("sequence", sequence);
            fields.put("chunkBytes", chunkBytes);
            fields.put("totalBytes", task.bufferedBytes);
            GenerationDebugLog.event(appContext, "native_progress", fields);
        }
    }

    private void endTask(StreamTask task) {
        synchronized (task.lock) {
            if (!STATE_RUNNING.equals(task.state)) {
                return;
            }
            task.state = STATE_ENDED;
            task.terminalAt = System.currentTimeMillis();
        }
        logSealed(task);
        notifyCompletionIfNeeded(task);
    }

    private void failTask(StreamTask task, IOException error) {
        String message = error.getMessage() == null ? error.getClass().getSimpleName() : error.getMessage();
        synchronized (task.lock) {
            if (!STATE_RUNNING.equals(task.state)) {
                return;
            }
            task.state = STATE_ERROR;
            task.error = message;
            task.terminalAt = System.currentTimeMillis();
        }
        Map<String, Object> fields = new HashMap<>();
        fields.put("streamId", task.id);
        fields.put("lastSequence", task.nextSequence - 1);
        fields.put("totalBytes", task.bufferedBytes);
        fields.put("errorType", error.getClass().getSimpleName());
        GenerationDebugLog.event(appContext, "native_failed", fields);
        logSealed(task);
    }

    private void finishTask(StreamTask task) {
        HttpURLConnection connection;
        synchronized (task.lock) {
            connection = task.connection;
            task.connection = null;
            task.workerThread = null;
            // Drop credentials and request bodies as soon as the network operation finishes.
            task.request = null;
        }
        if (connection != null) {
            connection.disconnect();
        }
        if (task.keepAlive) {
            BackgroundGenerationService.stop(appContext, task.id);
        }
    }

    private StreamSnapshot snapshotTask(StreamTask task, long afterSequence, int maxChunks, int maxBytes) {
        synchronized (task.lock) {
            List<ChunkRecord> selected = new ArrayList<>();
            boolean hasMore = false;
            int selectedBytes = 0;
            if (afterSequence != Long.MAX_VALUE) {
                int low = 0;
                int high = task.chunks.size();
                while (low < high) {
                    int middle = (low + high) >>> 1;
                    if (task.chunks.get(middle).sequence <= afterSequence) {
                        low = middle + 1;
                    } else {
                        high = middle;
                    }
                }
                int index = low;
                while (index < task.chunks.size() && selected.size() < maxChunks) {
                    ChunkRecord record = task.chunks.get(index);
                    int recordBytes = record.chunk.length;
                    if (!selected.isEmpty() && selectedBytes + recordBytes > maxBytes) {
                        break;
                    }
                    selected.add(record);
                    selectedBytes += recordBytes;
                    index += 1;
                }
                hasMore = index < task.chunks.size();
            }
            StreamSnapshot snapshot = new StreamSnapshot(
                task.id,
                task.clientRequestId,
                task.sessionId,
                task.messageId,
                task.state,
                task.error,
                task.nextSequence - 1,
                task.createdAt,
                selected,
                hasMore
            );
            if (afterSequence != Long.MAX_VALUE && (!selected.isEmpty() || isTerminal(task.state))) {
                long now = System.currentTimeMillis();
                boolean cursorAdvanced = afterSequence != task.lastSnapshotAfterSequence;
                if (cursorAdvanced) {
                    task.lastSnapshotAfterSequence = afterSequence;
                    task.repeatedSnapshotCount = 0;
                } else {
                    task.repeatedSnapshotCount += 1;
                }
                boolean firstForCursor = cursorAdvanced;
                boolean stalled = task.repeatedSnapshotCount >= 3 &&
                    now - task.lastSnapshotLogAt >= 5000L;
                if (!firstForCursor && !stalled) {
                    return snapshot;
                }
                task.lastSnapshotLogAt = now;
                Map<String, Object> fields = new HashMap<>();
                fields.put("streamId", task.id);
                fields.put("state", task.state);
                fields.put("afterSequence", afterSequence);
                if (!selected.isEmpty()) {
                    fields.put("firstSequence", selected.get(0).sequence);
                    fields.put("returnedThrough", selected.get(selected.size() - 1).sequence);
                }
                fields.put("lastSequence", task.nextSequence - 1);
                fields.put("chunkCount", selected.size());
                fields.put("batchBytes", selectedBytes);
                fields.put("hasMore", hasMore);
                fields.put("repeatCount", task.repeatedSnapshotCount);
                GenerationDebugLog.event(
                    appContext,
                    stalled ? "snapshot_stalled" : "snapshot_read",
                    fields
                );
            }
            return snapshot;
        }
    }

    private boolean isRunning(StreamTask task) {
        synchronized (task.lock) {
            return STATE_RUNNING.equals(task.state);
        }
    }

    private static boolean isTerminal(String state) {
        return STATE_ENDED.equals(state) || STATE_ERROR.equals(state) || STATE_CANCELLED.equals(state);
    }

    private void cleanupExpiredTasks() {
        long cutoff = System.currentTimeMillis() - TERMINAL_RETENTION_MS;
        for (Map.Entry<String, StreamTask> entry : tasks.entrySet()) {
            StreamTask task = entry.getValue();
            boolean expired;
            synchronized (task.lock) {
                expired = isTerminal(task.state) && task.terminalAt > 0 && task.terminalAt < cutoff;
            }
            if (expired) {
                synchronized (task.lock) {
                    task.removed = true;
                }
                tasks.remove(entry.getKey(), task);
            }
        }
    }

    private void logSealed(StreamTask task) {
        Map<String, Object> fields = new HashMap<>();
        fields.put("streamId", task.id);
        fields.put("state", task.state);
        fields.put("lastSequence", task.nextSequence - 1);
        fields.put("totalBytes", task.bufferedBytes);
        fields.put("durationMs", Math.max(0L, task.terminalAt - task.createdAt));
        GenerationDebugLog.event(appContext, "native_sealed", fields);
    }

    private void notifyCompletionIfNeeded(StreamTask task) {
        synchronized (task.lock) {
            if (
                task.completionNotified ||
                !STATE_ENDED.equals(task.state) ||
                !task.keepAlive ||
                "off".equals(task.completionNotificationMode)
            ) {
                return;
            }
            task.completionNotified = true;
        }
        if (!MainActivity.isAppVisible()) {
            BackgroundGenerationService.showCompletionNotification(
                appContext,
                task.id,
                task.sessionId,
                task.completionTitle,
                task.completionBody,
                task.completionNotificationMode
            );
        }
    }
}

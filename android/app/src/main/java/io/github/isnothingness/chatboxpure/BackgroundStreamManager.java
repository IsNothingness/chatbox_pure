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
import java.util.concurrent.Future;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

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

    private static final int MAX_BUFFERED_BYTES = 32 * 1024 * 1024;
    private static final long TERMINAL_RETENTION_MS = 60L * 60L * 1000L;
    private static final long PERSIST_DEBOUNCE_MS = 250L;
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
        boolean persistenceScheduled;
        boolean removed;
        boolean terminalDurable;
        boolean completionNotified;
        long durableThrough = -1;

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
    private final BackgroundStreamStore persistenceStore;
    private final Map<String, StreamTask> tasks = new ConcurrentHashMap<>();
    private final ExecutorService executor = Executors.newCachedThreadPool();
    private final ScheduledExecutorService persistenceExecutor = Executors.newSingleThreadScheduledExecutor();

    private BackgroundStreamManager(Context context) {
        appContext = context.getApplicationContext();
        persistenceStore = new BackgroundStreamStore(appContext);
        loadPersistedTasks();
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
            persistTaskSoon(task);
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
        persistTaskNow(task);
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
            if (!isTerminal(task.state) || !task.terminalDurable) {
                return;
            }
            task.removed = true;
        }
        tasks.remove(id, task);
        deletePersistedTask(id);
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
            task.state = STATE_ERROR;
            task.terminalAt = System.currentTimeMillis();
            task.terminalDurable = false;
        }
        if (connection != null) {
            connection.disconnect();
        }
        if (workerThread != null) {
            workerThread.interrupt();
        }
        if (task.keepAlive) {
            BackgroundGenerationService.stop(appContext, id);
        }
        // Cancellation stops the upstream request but keeps every byte already received.
        // The renderer can drain the durable tail and acknowledges the task only after
        // the final chat message has been saved.
        persistTaskNow(task);
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
        persistTaskSoon(task);
    }

    private void endTask(StreamTask task) {
        synchronized (task.lock) {
            if (!STATE_RUNNING.equals(task.state)) {
                return;
            }
            task.state = STATE_ENDED;
            task.terminalAt = System.currentTimeMillis();
            task.terminalDurable = false;
        }
        persistTaskNow(task);
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
            task.terminalDurable = false;
        }
        persistTaskNow(task);
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
                int selectedBytes = 0;
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
            return new StreamSnapshot(
                task.id,
                task.clientRequestId,
                task.sessionId,
                task.messageId,
                isTerminal(task.state) && !task.terminalDurable ? STATE_RUNNING : task.state,
                task.error,
                task.nextSequence - 1,
                task.createdAt,
                selected,
                hasMore
            );
        }
    }

    private boolean isRunning(StreamTask task) {
        synchronized (task.lock) {
            return STATE_RUNNING.equals(task.state);
        }
    }

    private static boolean isTerminal(String state) {
        return STATE_ENDED.equals(state) || STATE_ERROR.equals(state);
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
                deletePersistedTask(entry.getKey());
            }
        }
    }

    private void persistTaskSoon(StreamTask task) {
        synchronized (task.lock) {
            if (task.removed || task.persistenceScheduled) {
                return;
            }
            task.persistenceScheduled = true;
        }
        persistenceExecutor.schedule(
            () -> {
                synchronized (task.lock) {
                    task.persistenceScheduled = false;
                }
                if (!persistTask(task)) {
                    persistTaskSoon(task);
                }
            },
            PERSIST_DEBOUNCE_MS,
            TimeUnit.MILLISECONDS
        );
    }

    private boolean persistTaskNow(StreamTask task) {
        Future<Boolean> persistence = persistenceExecutor.submit(() -> persistTask(task));
        try {
            boolean persisted = persistence.get();
            if (!persisted) {
                persistTaskSoon(task);
            }
            return persisted;
        } catch (InterruptedException error) {
            Thread.currentThread().interrupt();
            Log.w(TAG, "Interrupted while persisting stream " + task.id, error);
        } catch (Exception error) {
            Log.w(TAG, "Could not persist stream " + task.id, error);
        }
        persistTaskSoon(task);
        return false;
    }

    private boolean persistTask(StreamTask task) {
        BackgroundStreamStore.StoredTask persistedTask;
        List<BackgroundStreamStore.StoredChunk> newChunks = new ArrayList<>();
        synchronized (task.lock) {
            if (task.removed) {
                return true;
            }
            for (ChunkRecord record : task.chunks) {
                if (record.sequence <= task.durableThrough) {
                    continue;
                }
                newChunks.add(
                    new BackgroundStreamStore.StoredChunk(
                        record.sequence,
                        record.chunk,
                        record.chunk.length
                    )
                );
            }
            persistedTask = new BackgroundStreamStore.StoredTask(
                task.id,
                task.clientRequestId,
                task.sessionId,
                task.messageId,
                task.state,
                task.error,
                task.createdAt,
                task.terminalAt,
                task.nextSequence - 1,
                task.bufferedBytes,
                Collections.emptyList()
            );
        }

        try {
            persistenceStore.writeTask(persistedTask, newChunks);
        } catch (RuntimeException error) {
            Log.w(TAG, "Could not write stream " + task.id + " to SQLite", error);
            return false;
        }

        boolean notifyCompletion = false;
        synchronized (task.lock) {
            if (task.removed) {
                persistenceStore.deleteTask(task.id);
                return true;
            }
            task.durableThrough = Math.max(task.durableThrough, persistedTask.lastSequence);
            if (
                isTerminal(task.state) &&
                task.durableThrough >= task.nextSequence - 1
            ) {
                task.terminalDurable = true;
                if (
                    STATE_ENDED.equals(task.state) &&
                    task.keepAlive &&
                    !"off".equals(task.completionNotificationMode) &&
                    !task.completionNotified
                ) {
                    task.completionNotified = true;
                    notifyCompletion = true;
                }
            }
        }
        if (notifyCompletion && !MainActivity.isAppVisible()) {
            BackgroundGenerationService.showCompletionNotification(
                appContext,
                task.id,
                task.sessionId,
                task.completionTitle,
                task.completionBody,
                task.completionNotificationMode
            );
        }
        return true;
    }

    private void loadPersistedTasks() {
        for (BackgroundStreamStore.StoredTask stored : persistenceStore.loadTasks()) {
            StreamTask task = new StreamTask(
                stored.id,
                stored.clientRequestId,
                stored.sessionId,
                stored.messageId,
                false,
                "off",
                "",
                "",
                null,
                stored.createdAt
            );
            task.started = true;
            task.state = stored.state;
            task.error = stored.error;
            task.terminalAt = stored.terminalAt;
            for (BackgroundStreamStore.StoredChunk chunk : stored.chunks) {
                task.chunks.add(new ChunkRecord(chunk.sequence, chunk.payload));
                task.bufferedBytes += chunk.byteCount;
                task.nextSequence = Math.max(task.nextSequence, chunk.sequence + 1);
                task.durableThrough = Math.max(task.durableThrough, chunk.sequence);
            }
            task.terminalDurable = isTerminal(stored.state);
            tasks.putIfAbsent(stored.id, task);

            if (!isTerminal(stored.state)) {
                task.state = STATE_ERROR;
                task.error = "Generation stopped because Android terminated the backend process";
                task.terminalAt = System.currentTimeMillis();
                task.terminalDurable = false;
                persistTaskNow(task);
            }
        }
        cleanupExpiredTasks();
    }

    private void deletePersistedTask(String id) {
        persistenceStore.deleteTask(id);
    }
}

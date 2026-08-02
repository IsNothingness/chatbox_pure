package io.github.isnothingness.chatboxpure;

import android.content.Context;

import com.chatbox.plugins.streamhttp.SSEParser;

import java.io.BufferedReader;
import java.io.BufferedWriter;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
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
import java.util.concurrent.CopyOnWriteArraySet;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Process-scoped owner for model response streams.
 *
 * Capacitor plugin instances are tied to a WebView and may be destroyed while a foreground
 * generation is still running. This manager is owned by the application process and is driven
 * by {@link BackgroundGenerationService}, so the connection and buffered chunks outlive an
 * Activity/WebView instance.
 */
final class BackgroundStreamManager {
    static final String STATE_PENDING = "pending";
    static final String STATE_RUNNING = "running";
    static final String STATE_ENDED = "ended";
    static final String STATE_ERROR = "error";

    private static final int MAX_BUFFERED_BYTES = 32 * 1024 * 1024;
    private static final long TERMINAL_RETENTION_MS = 60L * 60L * 1000L;
    private static volatile BackgroundStreamManager instance;

    interface Observer {
        void onChunk(String id, long sequence, String chunk);

        void onEnd(String id, long lastSequence);

        void onError(String id, long lastSequence, String error);
    }

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
        final String chunk;

        ChunkRecord(long sequence, String chunk) {
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

        StreamSnapshot(
            String id,
            String clientRequestId,
            String sessionId,
            String messageId,
            String state,
            String error,
            long lastSequence,
            long createdAt,
            List<ChunkRecord> chunks
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
        }
    }

    private static final class StreamTask {
        final String id;
        final String clientRequestId;
        final String sessionId;
        final String messageId;
        final boolean keepAlive;
        final boolean notifyWhenComplete;
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

        StreamTask(
            String id,
            String clientRequestId,
            String sessionId,
            String messageId,
            boolean keepAlive,
            boolean notifyWhenComplete,
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
                notifyWhenComplete,
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
            boolean notifyWhenComplete,
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
            this.notifyWhenComplete = notifyWhenComplete;
            this.completionTitle = completionTitle;
            this.completionBody = completionBody;
            this.request = request;
            this.createdAt = createdAt;
        }
    }

    private final Context appContext;
    private final File persistenceDirectory;
    private final Map<String, StreamTask> tasks = new ConcurrentHashMap<>();
    private final CopyOnWriteArraySet<Observer> observers = new CopyOnWriteArraySet<>();
    private final ExecutorService executor = Executors.newCachedThreadPool();

    private BackgroundStreamManager(Context context) {
        appContext = context.getApplicationContext();
        persistenceDirectory = new File(appContext.getFilesDir(), "background-streams");
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
        boolean notifyWhenComplete,
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
            notifyWhenComplete,
            completionTitle,
            completionBody,
            request
        );
        return tasks.putIfAbsent(id, task) == null;
    }

    void startTask(String id) {
        StreamTask task = tasks.get(id);
        if (task == null) {
            return;
        }
        synchronized (task.lock) {
            if (task.started || task.request == null) {
                return;
            }
            task.started = true;
            task.state = STATE_RUNNING;
        }
        executor.execute(() -> runTask(task));
    }

    void addObserver(Observer observer) {
        observers.add(observer);
    }

    void removeObserver(Observer observer) {
        observers.remove(observer);
    }

    StreamSnapshot snapshot(String id, long afterSequence) {
        StreamTask task = tasks.get(id);
        return task == null ? null : snapshotTask(task, afterSequence);
    }

    List<StreamSnapshot> listTasks() {
        cleanupExpiredTasks();
        List<StreamSnapshot> snapshots = new ArrayList<>();
        for (StreamTask task : tasks.values()) {
            snapshots.add(snapshotTask(task, Long.MAX_VALUE));
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
        }
        tasks.remove(id, task);
        deletePersistedTask(id);
    }

    void cancel(String id) {
        StreamTask task = tasks.remove(id);
        if (task == null) {
            return;
        }
        HttpURLConnection connection;
        Thread workerThread;
        synchronized (task.lock) {
            connection = task.connection;
            workerThread = task.workerThread;
            task.request = null;
            task.connection = null;
            task.workerThread = null;
            task.error = "Cancelled";
            task.state = STATE_ERROR;
            task.terminalAt = System.currentTimeMillis();
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
        deletePersistedTask(id);
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
            connection.setChunkedStreamingMode(0);

            if (
                request.body != null &&
                !request.body.isEmpty() &&
                !"GET".equalsIgnoreCase(request.method)
            ) {
                connection.setDoOutput(true);
                try (OutputStream output = connection.getOutputStream()) {
                    output.write(request.body.getBytes(StandardCharsets.UTF_8));
                }
            }

            int responseCode = connection.getResponseCode();
            InputStream inputStream = responseCode >= 200 && responseCode < 300
                ? connection.getInputStream()
                : connection.getErrorStream();
            if (inputStream != null) {
                readEvents(task, inputStream);
            }
            if (isRunning(task)) {
                endTask(task);
            }
        } catch (IOException error) {
            if (isRunning(task)) {
                failTask(task, error);
            }
        } finally {
            finishTask(task);
        }
    }

    private void readEvents(StreamTask task, InputStream inputStream) throws IOException {
        try (BufferedReader reader = new BufferedReader(
            new InputStreamReader(inputStream, StandardCharsets.UTF_8)
        )) {
            SSEParser parser = new SSEParser();
            String line;
            while ((line = reader.readLine()) != null) {
                if (!isRunning(task)) {
                    break;
                }
                appendChunk(task, parser.processLine(line));
            }
            appendChunk(task, parser.processLine(""));
            appendChunk(task, parser.flush());
        }
    }

    private void appendChunk(StreamTask task, String chunk) throws IOException {
        if (chunk == null || chunk.isEmpty()) {
            return;
        }
        long sequence;
        int chunkBytes = chunk.getBytes(StandardCharsets.UTF_8).length;
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
        for (Observer observer : observers) {
            observer.onChunk(task.id, sequence, chunk);
        }
    }

    private void endTask(StreamTask task) {
        long lastSequence;
        synchronized (task.lock) {
            if (!STATE_RUNNING.equals(task.state)) {
                return;
            }
            task.state = STATE_ENDED;
            task.terminalAt = System.currentTimeMillis();
            lastSequence = task.nextSequence - 1;
        }
        persistTerminalTask(task);
        for (Observer observer : observers) {
            observer.onEnd(task.id, lastSequence);
        }
        if (task.keepAlive && task.notifyWhenComplete && !MainActivity.isAppVisible()) {
            BackgroundGenerationService.showCompletionNotification(
                appContext,
                task.completionTitle,
                task.completionBody
            );
        }
    }

    private void failTask(StreamTask task, IOException error) {
        long lastSequence;
        String message = error.getMessage() == null ? error.getClass().getSimpleName() : error.getMessage();
        synchronized (task.lock) {
            if (!STATE_RUNNING.equals(task.state)) {
                return;
            }
            task.state = STATE_ERROR;
            task.error = message;
            task.terminalAt = System.currentTimeMillis();
            lastSequence = task.nextSequence - 1;
        }
        persistTerminalTask(task);
        for (Observer observer : observers) {
            observer.onError(task.id, lastSequence, message);
        }
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

    private StreamSnapshot snapshotTask(StreamTask task, long afterSequence) {
        synchronized (task.lock) {
            List<ChunkRecord> selected = new ArrayList<>();
            if (afterSequence != Long.MAX_VALUE) {
                for (ChunkRecord record : task.chunks) {
                    if (record.sequence > afterSequence) {
                        selected.add(record);
                    }
                }
            }
            return new StreamSnapshot(
                task.id,
                task.clientRequestId,
                task.sessionId,
                task.messageId,
                task.state,
                task.error,
                task.nextSequence - 1,
                task.createdAt,
                selected
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
                tasks.remove(entry.getKey(), task);
                deletePersistedTask(entry.getKey());
            }
        }
    }

    private void persistTerminalTask(StreamTask task) {
        JSONObject json = new JSONObject();
        try {
            synchronized (task.lock) {
                json.put("id", task.id);
                json.put("clientRequestId", task.clientRequestId);
                json.put("sessionId", task.sessionId);
                json.put("messageId", task.messageId);
                json.put("state", task.state);
                json.put("error", task.error);
                json.put("createdAt", task.createdAt);
                json.put("terminalAt", task.terminalAt);
                JSONArray chunks = new JSONArray();
                for (ChunkRecord record : task.chunks) {
                    JSONObject chunk = new JSONObject();
                    chunk.put("sequence", record.sequence);
                    chunk.put("chunk", record.chunk);
                    chunks.put(chunk);
                }
                json.put("chunks", chunks);
            }
        } catch (JSONException error) {
            return;
        }

        if (!persistenceDirectory.exists() && !persistenceDirectory.mkdirs()) {
            return;
        }
        File target = persistedTaskFile(task.id);
        File temporary = new File(target.getParentFile(), target.getName() + ".tmp");
        try (
            BufferedWriter writer = new BufferedWriter(
                new OutputStreamWriter(new FileOutputStream(temporary), StandardCharsets.UTF_8)
            )
        ) {
            writer.write(json.toString());
        } catch (IOException error) {
            temporary.delete();
            return;
        }
        if (target.exists() && !target.delete()) {
            temporary.delete();
            return;
        }
        if (!temporary.renameTo(target)) {
            temporary.delete();
        }
    }

    private void loadPersistedTasks() {
        if (!persistenceDirectory.exists()) {
            return;
        }
        File[] files = persistenceDirectory.listFiles((directory, name) -> name.endsWith(".json"));
        if (files == null) {
            return;
        }
        for (File file : files) {
            try {
                StringBuilder serialized = new StringBuilder();
                try (
                    BufferedReader reader = new BufferedReader(
                        new InputStreamReader(new FileInputStream(file), StandardCharsets.UTF_8)
                    )
                ) {
                    String line;
                    while ((line = reader.readLine()) != null) {
                        serialized.append(line);
                    }
                }
                JSONObject json = new JSONObject(serialized.toString());
                String id = json.getString("id");
                String state = json.getString("state");
                if (!isTerminal(state)) {
                    file.delete();
                    continue;
                }
                StreamTask task = new StreamTask(
                    id,
                    nullableString(json, "clientRequestId"),
                    nullableString(json, "sessionId"),
                    nullableString(json, "messageId"),
                    false,
                    false,
                    "",
                    "",
                    null,
                    json.optLong("createdAt", file.lastModified())
                );
                task.started = true;
                task.state = state;
                task.error = nullableString(json, "error");
                task.terminalAt = json.optLong("terminalAt", file.lastModified());
                JSONArray chunks = json.optJSONArray("chunks");
                if (chunks != null) {
                    for (int index = 0; index < chunks.length(); index++) {
                        JSONObject chunk = chunks.getJSONObject(index);
                        String value = chunk.getString("chunk");
                        long sequence = chunk.getLong("sequence");
                        task.chunks.add(new ChunkRecord(sequence, value));
                        task.bufferedBytes += value.getBytes(StandardCharsets.UTF_8).length;
                        task.nextSequence = Math.max(task.nextSequence, sequence + 1);
                    }
                }
                tasks.putIfAbsent(id, task);
            } catch (IOException | JSONException error) {
                file.delete();
            }
        }
        cleanupExpiredTasks();
    }

    private File persistedTaskFile(String id) {
        String safeId = id.replaceAll("[^A-Za-z0-9._-]", "_");
        return new File(persistenceDirectory, safeId + ".json");
    }

    private void deletePersistedTask(String id) {
        File file = persistedTaskFile(id);
        if (file.exists()) {
            file.delete();
        }
    }

    private static String nullableString(JSONObject json, String key) {
        return json.isNull(key) ? null : json.optString(key, null);
    }
}

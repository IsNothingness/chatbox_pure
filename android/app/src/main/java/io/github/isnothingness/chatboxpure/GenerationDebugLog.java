package io.github.isnothingness.chatboxpure;

import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Log;

import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Debug-build-only JSONL diagnostics for the confirmed generation pipeline.
 *
 * The event and field allowlists deliberately exclude request URLs, headers, bodies,
 * credentials and generated text. Identifiers are hashed before leaving the process.
 */
final class GenerationDebugLog {
    private static final String TAG = "GenerationDebugLog";
    private static final String DIRECTORY_NAME = "ChatBox Pure Debug";
    private static final ExecutorService WRITER = Executors.newSingleThreadExecutor();
    private static final Object FILE_LOCK = new Object();
    private static final Set<String> ALLOWED_EVENTS = new HashSet<>();
    private static final Set<String> ALLOWED_FIELDS = new HashSet<>();
    private static Uri mediaStoreUri;
    private static File legacyFile;
    private static String fileName;

    static {
        String[] events = {
            "debug_log_started",
            "stream_created",
            "stream_started",
            "native_progress",
            "snapshot_read",
            "snapshot_stalled",
            "cancel_requested",
            "native_sealed",
            "native_failed",
            "stream_acknowledged",
            "bridge_reader_started",
            "bridge_snapshot_received",
            "bridge_cursor_stalled",
            "bridge_reader_completed",
            "bridge_reader_cancelled",
            "generation_runtime_started",
            "generation_stream_started",
            "generation_stream_completed",
            "generation_checkpoint",
            "generation_cancel_requested",
            "generation_finalizing",
            "generation_incomplete_eof",
            "sql_commit_started",
            "sql_commit_completed",
            "sql_commit_failed",
            "generation_runtime_released"
        };
        for (String event : events) ALLOWED_EVENTS.add(event);

        String[] fields = {
            "streamId",
            "sessionId",
            "messageId",
            "state",
            "sequence",
            "afterSequence",
            "firstSequence",
            "returnedThrough",
            "expectedSequence",
            "lastSequence",
            "repeatCount",
            "pendingChunks",
            "pendingBytes",
            "chunkBytes",
            "batchBytes",
            "totalBytes",
            "chunkCount",
            "contentChars",
            "contentParts",
            "durationMs",
            "keepAlive",
            "hasMore",
            "stopRequested",
            "finishReasonPresent",
            "errorType",
            "success"
        };
        for (String field : fields) ALLOWED_FIELDS.add(field);
    }

    private GenerationDebugLog() {}

    static boolean isEnabled(Context context) {
        return context != null &&
            (context.getApplicationInfo().flags & android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0;
    }

    static void event(Context context, String event, Map<String, ?> fields) {
        if (!isEnabled(context) || !ALLOWED_EVENTS.contains(event)) {
            return;
        }
        Context appContext = context.getApplicationContext();
        Map<String, Object> safeFields = sanitize(fields);
        WRITER.execute(() -> write(appContext, event, safeFields));
    }

    static void event(Context context, String event) {
        event(context, event, new HashMap<>());
    }

    private static Map<String, Object> sanitize(Map<String, ?> fields) {
        Map<String, Object> result = new HashMap<>();
        if (fields == null) return result;
        for (Map.Entry<String, ?> entry : fields.entrySet()) {
            String key = entry.getKey();
            Object value = entry.getValue();
            if (!ALLOWED_FIELDS.contains(key) || value == null) continue;
            if ("streamId".equals(key) || "sessionId".equals(key) || "messageId".equals(key)) {
                result.put(key.substring(0, key.length() - 2) + "Hash", shortHash(String.valueOf(value)));
            } else if (value instanceof Number || value instanceof Boolean) {
                result.put(key, value);
            } else {
                result.put(key, trimSafeValue(String.valueOf(value)));
            }
        }
        return result;
    }

    private static String trimSafeValue(String value) {
        return value.length() <= 80 ? value : value.substring(0, 80);
    }

    private static String shortHash(String value) {
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8));
            StringBuilder result = new StringBuilder();
            for (int index = 0; index < 6; index += 1) {
                result.append(String.format(Locale.US, "%02x", digest[index]));
            }
            return result.toString();
        } catch (Exception error) {
            return "hash-error";
        }
    }

    private static void write(Context context, String event, Map<String, Object> fields) {
        try {
            JSONObject record = new JSONObject();
            record.put("timestamp", System.currentTimeMillis());
            record.put("event", event);
            record.put("process", android.os.Process.myPid());
            for (Map.Entry<String, Object> entry : fields.entrySet()) {
                record.put(entry.getKey(), entry.getValue());
            }
            byte[] line = (record.toString() + "\n").getBytes(StandardCharsets.UTF_8);
            synchronized (FILE_LOCK) {
                ensureTarget(context);
                try (OutputStream output = openOutput(context)) {
                    output.write(line);
                    output.flush();
                }
            }
        } catch (Exception error) {
            Log.w(TAG, "Could not write generation debug log", error);
        }
    }

    private static void ensureTarget(Context context) throws Exception {
        if (mediaStoreUri != null || legacyFile != null) return;
        fileName = "generation-" +
            new SimpleDateFormat("yyyyMMdd-HHmmss", Locale.US).format(new Date()) +
            "-" + android.os.Process.myPid() + ".jsonl";
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            ContentValues values = new ContentValues();
            values.put(MediaStore.MediaColumns.DISPLAY_NAME, fileName);
            values.put(MediaStore.MediaColumns.MIME_TYPE, "application/json");
            values.put(
                MediaStore.MediaColumns.RELATIVE_PATH,
                Environment.DIRECTORY_DOCUMENTS + "/" + DIRECTORY_NAME
            );
            ContentResolver resolver = context.getContentResolver();
            mediaStoreUri = resolver.insert(MediaStore.Files.getContentUri("external"), values);
            if (mediaStoreUri == null) {
                throw new IllegalStateException("Could not create debug log in MediaStore");
            }
        } else {
            File documents = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOCUMENTS);
            File directory = new File(documents, DIRECTORY_NAME);
            if (!directory.exists() && !directory.mkdirs()) {
                throw new IllegalStateException("Could not create debug log directory");
            }
            legacyFile = new File(directory, fileName);
        }
    }

    private static OutputStream openOutput(Context context) throws Exception {
        if (mediaStoreUri != null) {
            OutputStream output = context.getContentResolver().openOutputStream(mediaStoreUri, "wa");
            if (output == null) throw new IllegalStateException("Could not open debug log");
            return output;
        }
        if (legacyFile == null) throw new IllegalStateException("Debug log target is unavailable");
        return new FileOutputStream(legacyFile, true);
    }
}

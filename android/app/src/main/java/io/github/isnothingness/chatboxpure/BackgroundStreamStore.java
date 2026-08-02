package io.github.isnothingness.chatboxpure;

import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteOpenHelper;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Durable, private task storage for native model streams.
 *
 * Request URLs, headers, bodies and credentials are deliberately never persisted. If Android
 * terminates the process, already received response chunks can be recovered, but the billable
 * request is never submitted a second time automatically.
 */
final class BackgroundStreamStore extends SQLiteOpenHelper {
    private static final String DATABASE_NAME = "background_streams.db";
    private static final int DATABASE_VERSION = 1;

    static final class StoredChunk {
        final long sequence;
        final String payload;
        final int byteCount;

        StoredChunk(long sequence, String payload, int byteCount) {
            this.sequence = sequence;
            this.payload = payload;
            this.byteCount = byteCount;
        }
    }

    static final class StoredTask {
        final String id;
        final String clientRequestId;
        final String sessionId;
        final String messageId;
        final String state;
        final String error;
        final long createdAt;
        final long terminalAt;
        final long lastSequence;
        final int totalBytes;
        final List<StoredChunk> chunks;

        StoredTask(
            String id,
            String clientRequestId,
            String sessionId,
            String messageId,
            String state,
            String error,
            long createdAt,
            long terminalAt,
            long lastSequence,
            int totalBytes,
            List<StoredChunk> chunks
        ) {
            this.id = id;
            this.clientRequestId = clientRequestId;
            this.sessionId = sessionId;
            this.messageId = messageId;
            this.state = state;
            this.error = error;
            this.createdAt = createdAt;
            this.terminalAt = terminalAt;
            this.lastSequence = lastSequence;
            this.totalBytes = totalBytes;
            this.chunks = chunks;
        }
    }

    BackgroundStreamStore(Context context) {
        super(context.getApplicationContext(), DATABASE_NAME, null, DATABASE_VERSION);
        setWriteAheadLoggingEnabled(true);
    }

    @Override
    public void onConfigure(SQLiteDatabase database) {
        super.onConfigure(database);
        database.setForeignKeyConstraintsEnabled(true);
    }

    @Override
    public void onCreate(SQLiteDatabase database) {
        database.execSQL(
            "CREATE TABLE stream_tasks (" +
                "id TEXT PRIMARY KEY NOT NULL," +
                "client_request_id TEXT," +
                "session_id TEXT," +
                "message_id TEXT," +
                "state TEXT NOT NULL," +
                "error TEXT," +
                "created_at INTEGER NOT NULL," +
                "terminal_at INTEGER NOT NULL DEFAULT 0," +
                "last_sequence INTEGER NOT NULL DEFAULT -1," +
                "total_bytes INTEGER NOT NULL DEFAULT 0" +
            ")"
        );
        database.execSQL(
            "CREATE TABLE stream_chunks (" +
                "task_id TEXT NOT NULL," +
                "sequence INTEGER NOT NULL," +
                "payload TEXT NOT NULL," +
                "byte_count INTEGER NOT NULL," +
                "PRIMARY KEY(task_id, sequence)," +
                "FOREIGN KEY(task_id) REFERENCES stream_tasks(id) ON DELETE CASCADE" +
            ")"
        );
        database.execSQL(
            "CREATE INDEX stream_tasks_terminal_at_idx ON stream_tasks(terminal_at)"
        );
    }

    @Override
    public void onUpgrade(SQLiteDatabase database, int oldVersion, int newVersion) {
        // Version 1 is the initial schema.
    }

    void writeTask(StoredTask task, List<StoredChunk> newChunks) {
        SQLiteDatabase database = getWritableDatabase();
        database.beginTransaction();
        try {
            ContentValues taskValues = new ContentValues();
            taskValues.put("id", task.id);
            putNullable(taskValues, "client_request_id", task.clientRequestId);
            putNullable(taskValues, "session_id", task.sessionId);
            putNullable(taskValues, "message_id", task.messageId);
            taskValues.put("state", task.state);
            putNullable(taskValues, "error", task.error);
            taskValues.put("created_at", task.createdAt);
            taskValues.put("terminal_at", task.terminalAt);
            taskValues.put("last_sequence", task.lastSequence);
            taskValues.put("total_bytes", task.totalBytes);
            long inserted = database.insertWithOnConflict(
                "stream_tasks",
                null,
                taskValues,
                SQLiteDatabase.CONFLICT_IGNORE
            );
            if (inserted == -1L) {
                taskValues.remove("id");
                database.update("stream_tasks", taskValues, "id = ?", new String[] { task.id });
            }

            for (StoredChunk chunk : newChunks) {
                ContentValues chunkValues = new ContentValues();
                chunkValues.put("task_id", task.id);
                chunkValues.put("sequence", chunk.sequence);
                chunkValues.put("payload", chunk.payload);
                chunkValues.put("byte_count", chunk.byteCount);
                database.insertWithOnConflict(
                    "stream_chunks",
                    null,
                    chunkValues,
                    SQLiteDatabase.CONFLICT_REPLACE
                );
            }
            database.setTransactionSuccessful();
        } finally {
            database.endTransaction();
        }
    }

    List<StoredTask> loadTasks() {
        SQLiteDatabase database = getReadableDatabase();
        Map<String, StoredTask> tasks = new LinkedHashMap<>();
        try (
            Cursor cursor = database.query(
                "stream_tasks",
                null,
                null,
                null,
                null,
                null,
                "created_at ASC"
            )
        ) {
            while (cursor.moveToNext()) {
                String id = cursor.getString(cursor.getColumnIndexOrThrow("id"));
                tasks.put(
                    id,
                    new StoredTask(
                        id,
                        nullableString(cursor, "client_request_id"),
                        nullableString(cursor, "session_id"),
                        nullableString(cursor, "message_id"),
                        cursor.getString(cursor.getColumnIndexOrThrow("state")),
                        nullableString(cursor, "error"),
                        cursor.getLong(cursor.getColumnIndexOrThrow("created_at")),
                        cursor.getLong(cursor.getColumnIndexOrThrow("terminal_at")),
                        cursor.getLong(cursor.getColumnIndexOrThrow("last_sequence")),
                        cursor.getInt(cursor.getColumnIndexOrThrow("total_bytes")),
                        new ArrayList<>()
                    )
                );
            }
        }

        try (
            Cursor cursor = database.query(
                "stream_chunks",
                null,
                null,
                null,
                null,
                null,
                "task_id ASC, sequence ASC"
            )
        ) {
            while (cursor.moveToNext()) {
                StoredTask task = tasks.get(cursor.getString(cursor.getColumnIndexOrThrow("task_id")));
                if (task == null) {
                    continue;
                }
                task.chunks.add(
                    new StoredChunk(
                        cursor.getLong(cursor.getColumnIndexOrThrow("sequence")),
                        cursor.getString(cursor.getColumnIndexOrThrow("payload")),
                        cursor.getInt(cursor.getColumnIndexOrThrow("byte_count"))
                    )
                );
            }
        }
        return new ArrayList<>(tasks.values());
    }

    void deleteTask(String id) {
        getWritableDatabase().delete("stream_tasks", "id = ?", new String[] { id });
    }

    private static void putNullable(ContentValues values, String key, String value) {
        if (value == null) {
            values.putNull(key);
        } else {
            values.put(key, value);
        }
    }

    private static String nullableString(Cursor cursor, String column) {
        int index = cursor.getColumnIndexOrThrow(column);
        return cursor.isNull(index) ? null : cursor.getString(index);
    }
}

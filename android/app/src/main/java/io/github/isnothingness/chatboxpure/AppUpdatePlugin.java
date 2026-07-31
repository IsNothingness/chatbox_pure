package io.github.isnothingness.chatboxpure;

import android.Manifest;
import android.app.DownloadManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.SharedPreferences;
import android.content.pm.PackageInfo;
import android.content.pm.PackageInstaller;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import androidx.core.content.ContextCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileInputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.security.MessageDigest;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

@CapacitorPlugin(name = "AppUpdate")
public class AppUpdatePlugin extends Plugin {
    private static final String PREFS_NAME = "chatbox_pure_app_update";
    private static final String INSTALL_STATUS_ACTION = "io.github.isnothingness.chatboxpure.APP_UPDATE_INSTALL_STATUS";
    private static final long NO_DOWNLOAD = -1L;
    private static final int POLL_INTERVAL_MS = 750;

    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private final ExecutorService ioExecutor = Executors.newSingleThreadExecutor();

    private DownloadManager downloadManager;
    private SharedPreferences preferences;
    private long downloadId = NO_DOWNLOAD;
    private String version;
    private String url;
    private String expectedSha256;
    private long expectedSize;
    private String filePath;
    private String status = "idle";
    private int progress;
    private String errorCode;
    private boolean verificationRunning;
    private boolean receiversRegistered;

    private final Runnable progressPoller = new Runnable() {
        @Override
        public void run() {
            queryDownload();
            if ("downloading".equals(status)) {
                mainHandler.postDelayed(this, POLL_INTERVAL_MS);
            }
        }
    };

    private final BroadcastReceiver downloadReceiver = new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            long completedId = intent.getLongExtra(DownloadManager.EXTRA_DOWNLOAD_ID, NO_DOWNLOAD);
            if (completedId == downloadId) {
                queryDownload();
            }
        }
    };

    private final BroadcastReceiver installReceiver = new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            int installStatus = intent.getIntExtra(
                PackageInstaller.EXTRA_STATUS,
                PackageInstaller.STATUS_FAILURE
            );
            if (installStatus == PackageInstaller.STATUS_PENDING_USER_ACTION) {
                Intent confirmationIntent = getParcelableIntent(intent);
                if (confirmationIntent == null) {
                    fail("installer-confirmation-missing");
                    return;
                }
                confirmationIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                context.startActivity(confirmationIntent);
                return;
            }
            if (installStatus == PackageInstaller.STATUS_SUCCESS) {
                clearPersistedUpdate();
                updateState("idle", 100, null);
                return;
            }
            fail("installer-failed");
        }
    };

    @Override
    public void load() {
        Context context = getContext();
        downloadManager = (DownloadManager) context.getSystemService(Context.DOWNLOAD_SERVICE);
        preferences = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        restoreState();
        registerReceivers();

        if ("downloading".equals(status) || "verifying".equals(status)) {
            status = "downloading";
            startPolling();
        }
    }

    @Override
    protected void handleOnResume() {
        if ("permission-required".equals(status) && canRequestPackageInstalls()) {
            launchInstaller();
        } else if ("downloaded".equals(status) && canRequestPackageInstalls()) {
            launchInstaller();
        } else if ("downloading".equals(status)) {
            startPolling();
        }
    }

    @Override
    protected void handleOnDestroy() {
        mainHandler.removeCallbacks(progressPoller);
        if (receiversRegistered) {
            try {
                getContext().unregisterReceiver(downloadReceiver);
            } catch (IllegalArgumentException ignored) {}
            try {
                getContext().unregisterReceiver(installReceiver);
            } catch (IllegalArgumentException ignored) {}
        }
        ioExecutor.shutdownNow();
    }

    @PluginMethod
    public void startUpdate(PluginCall call) {
        String requestedVersion = call.getString("version");
        String requestedUrl = call.getString("url");
        String requestedSha256 = call.getString("sha256");
        Long requestedSize = call.getLong("size");

        if (!isValidRequest(requestedVersion, requestedUrl, requestedSha256, requestedSize)) {
            call.reject("Invalid update package metadata", "INVALID_METADATA");
            return;
        }

        cancelCurrentDownload();
        version = requestedVersion;
        url = requestedUrl;
        expectedSha256 = requestedSha256.toLowerCase(Locale.ROOT);
        expectedSize = requestedSize;
        filePath = updateFile(requestedVersion).getAbsolutePath();
        progress = 0;
        errorCode = null;
        downloadId = NO_DOWNLOAD;
        persistState();

        enqueueDownload();
        call.resolve(stateResult());
    }

    @PluginMethod
    public void resumeUpdate(PluginCall call) {
        if (!hasPendingMetadata()) {
            call.resolve(stateResult());
            return;
        }

        if ("permission-required".equals(status) || "downloaded".equals(status)) {
            launchInstaller();
        } else if ("downloading".equals(status) || "verifying".equals(status)) {
            queryDownload();
        } else if (!"installing".equals(status)) {
            enqueueDownload();
        }
        call.resolve(stateResult());
    }

    @PluginMethod
    public void getState(PluginCall call) {
        if ("downloading".equals(status)) {
            queryDownload();
        }
        call.resolve(stateResult());
    }

    private boolean isValidRequest(String requestedVersion, String requestedUrl, String requestedSha256, Long requestedSize) {
        if (
            requestedVersion == null ||
            requestedVersion.isBlank() ||
            requestedUrl == null ||
            requestedSha256 == null ||
            requestedSize == null ||
            requestedSize <= 0
        ) {
            return false;
        }
        Uri uri = Uri.parse(requestedUrl);
        return (
            "https".equalsIgnoreCase(uri.getScheme()) &&
            requestedSha256.matches("(?i)^[0-9a-f]{64}$")
        );
    }

    private boolean hasPendingMetadata() {
        return (
            version != null &&
            url != null &&
            expectedSha256 != null &&
            expectedSize > 0 &&
            filePath != null
        );
    }

    private void enqueueDownload() {
        if (!hasPendingMetadata()) {
            fail("metadata-missing");
            return;
        }

        File target = new File(filePath);
        File parent = target.getParentFile();
        if (parent == null || (!parent.exists() && !parent.mkdirs())) {
            fail("download-directory-unavailable");
            return;
        }
        if (target.exists() && !target.delete()) {
            fail("old-package-delete-failed");
            return;
        }

        try {
            DownloadManager.Request request = new DownloadManager.Request(Uri.parse(url))
                .setTitle("ChatBox Pure v" + version)
                .setDescription("Downloading verified application update")
                .setMimeType("application/vnd.android.package-archive")
                .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE)
                .setAllowedOverMetered(true)
                .setAllowedOverRoaming(false)
                .setDestinationUri(Uri.fromFile(target));

            downloadId = downloadManager.enqueue(request);
            updateState("downloading", 0, null);
            startPolling();
        } catch (RuntimeException error) {
            fail("download-start-failed");
        }
    }

    private File updateFile(String updateVersion) {
        File downloads = getContext().getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
        if (downloads == null) {
            downloads = new File(getContext().getFilesDir(), "downloads");
        }
        String safeVersion = updateVersion.replaceAll("[^0-9A-Za-z._-]", "_");
        return new File(new File(downloads, "updates"), "ChatBox-Pure-" + safeVersion + ".apk");
    }

    private void startPolling() {
        mainHandler.removeCallbacks(progressPoller);
        mainHandler.post(progressPoller);
    }

    private void queryDownload() {
        if (downloadId == NO_DOWNLOAD || downloadManager == null) {
            return;
        }

        DownloadManager.Query query = new DownloadManager.Query().setFilterById(downloadId);
        try (Cursor cursor = downloadManager.query(query)) {
            if (cursor == null || !cursor.moveToFirst()) {
                fail("download-not-found");
                return;
            }

            int downloadStatus = cursor.getInt(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS));
            long downloaded = cursor.getLong(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_BYTES_DOWNLOADED_SO_FAR));
            long total = cursor.getLong(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_TOTAL_SIZE_BYTES));
            int nextProgress = total > 0 ? (int) Math.min(99, (downloaded * 100L) / total) : progress;

            if (downloadStatus == DownloadManager.STATUS_SUCCESSFUL) {
                mainHandler.removeCallbacks(progressPoller);
                verifyDownloadedPackage();
            } else if (downloadStatus == DownloadManager.STATUS_FAILED) {
                mainHandler.removeCallbacks(progressPoller);
                fail("download-failed");
            } else {
                updateState("downloading", nextProgress, null);
            }
        } catch (RuntimeException error) {
            fail("download-query-failed");
        }
    }

    private void verifyDownloadedPackage() {
        synchronized (this) {
            if (verificationRunning) {
                return;
            }
            verificationRunning = true;
        }
        updateState("verifying", 100, null);

        ioExecutor.execute(() -> {
            try {
                File apk = new File(filePath);
                if (!apk.isFile() || apk.length() != expectedSize) {
                    throw new VerificationException("size-mismatch");
                }
                if (!expectedSha256.equals(sha256(apk))) {
                    throw new VerificationException("sha256-mismatch");
                }
                verifyPackageIdentity(apk);
                updateState("downloaded", 100, null);
                mainHandler.post(this::launchInstaller);
            } catch (VerificationException error) {
                fail(error.getMessage());
            } catch (Exception error) {
                fail("verification-failed");
            } finally {
                synchronized (this) {
                    verificationRunning = false;
                }
            }
        });
    }

    private String sha256(File file) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        try (InputStream input = new FileInputStream(file)) {
            byte[] buffer = new byte[64 * 1024];
            int count;
            while ((count = input.read(buffer)) != -1) {
                digest.update(buffer, 0, count);
            }
        }
        StringBuilder result = new StringBuilder(64);
        for (byte value : digest.digest()) {
            result.append(String.format(Locale.ROOT, "%02x", value & 0xff));
        }
        return result.toString();
    }

    private void verifyPackageIdentity(File apk) throws Exception {
        PackageManager packageManager = getContext().getPackageManager();
        int flags = Build.VERSION.SDK_INT >= Build.VERSION_CODES.P
            ? PackageManager.GET_SIGNING_CERTIFICATES
            : PackageManager.GET_SIGNATURES;
        PackageInfo archive = packageManager.getPackageArchiveInfo(apk.getAbsolutePath(), flags);
        PackageInfo installed = packageManager.getPackageInfo(getContext().getPackageName(), flags);

        if (archive == null || !getContext().getPackageName().equals(archive.packageName)) {
            throw new VerificationException("package-name-mismatch");
        }
        if (longVersionCode(archive) <= longVersionCode(installed)) {
            throw new VerificationException("version-not-newer");
        }
        if (!signerDigests(archive).equals(signerDigests(installed))) {
            throw new VerificationException("signer-mismatch");
        }
    }

    private long longVersionCode(PackageInfo packageInfo) {
        return Build.VERSION.SDK_INT >= Build.VERSION_CODES.P
            ? packageInfo.getLongVersionCode()
            : packageInfo.versionCode;
    }

    @SuppressWarnings("deprecation")
    private Set<String> signerDigests(PackageInfo packageInfo) throws Exception {
        Signature[] signatures;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            if (packageInfo.signingInfo == null) {
                throw new VerificationException("signer-missing");
            }
            signatures = packageInfo.signingInfo.getApkContentsSigners();
        } else {
            signatures = packageInfo.signatures;
        }
        if (signatures == null || signatures.length == 0) {
            throw new VerificationException("signer-missing");
        }

        Set<String> digests = new HashSet<>();
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        for (Signature signature : signatures) {
            byte[] value = digest.digest(signature.toByteArray());
            digests.add(Arrays.toString(value));
            digest.reset();
        }
        return digests;
    }

    private void launchInstaller() {
        if (!canRequestPackageInstalls()) {
            updateState("permission-required", 100, null);
            openInstallPermissionSettings();
            return;
        }
        if (filePath == null || !new File(filePath).isFile()) {
            fail("verified-package-missing");
            return;
        }

        updateState("installing", 100, null);
        ioExecutor.execute(() -> {
            PackageInstaller packageInstaller = getContext().getPackageManager().getPackageInstaller();
            PackageInstaller.SessionParams params = new PackageInstaller.SessionParams(
                PackageInstaller.SessionParams.MODE_FULL_INSTALL
            );
            params.setAppPackageName(getContext().getPackageName());

            int sessionId = -1;
            try {
                sessionId = packageInstaller.createSession(params);
                try (
                    PackageInstaller.Session session = packageInstaller.openSession(sessionId);
                    InputStream input = new FileInputStream(filePath);
                    OutputStream output = session.openWrite("base.apk", 0, expectedSize)
                ) {
                    byte[] buffer = new byte[64 * 1024];
                    int count;
                    while ((count = input.read(buffer)) != -1) {
                        output.write(buffer, 0, count);
                    }
                    session.fsync(output);

                    Intent resultIntent = new Intent(INSTALL_STATUS_ACTION).setPackage(getContext().getPackageName());
                    int flags = PendingIntent.FLAG_UPDATE_CURRENT;
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                        flags |= PendingIntent.FLAG_MUTABLE;
                    }
                    PendingIntent pendingIntent = PendingIntent.getBroadcast(
                        getContext(),
                        sessionId,
                        resultIntent,
                        flags
                    );
                    session.commit(pendingIntent.getIntentSender());
                }
            } catch (Exception error) {
                if (sessionId != -1) {
                    packageInstaller.abandonSession(sessionId);
                }
                fail("installer-session-failed");
            }
        });
    }

    private boolean canRequestPackageInstalls() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            return true;
        }
        return (
            ContextCompat.checkSelfPermission(getContext(), Manifest.permission.REQUEST_INSTALL_PACKAGES) ==
                PackageManager.PERMISSION_GRANTED &&
            getContext().getPackageManager().canRequestPackageInstalls()
        );
    }

    private void openInstallPermissionSettings() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            return;
        }
        Intent intent = new Intent(
            Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
            Uri.parse("package:" + getContext().getPackageName())
        );
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            getContext().startActivity(intent);
        } catch (RuntimeException error) {
            fail("install-permission-settings-unavailable");
        }
    }

    private void registerReceivers() {
        ContextCompat.registerReceiver(
            getContext(),
            downloadReceiver,
            new IntentFilter(DownloadManager.ACTION_DOWNLOAD_COMPLETE),
            ContextCompat.RECEIVER_EXPORTED
        );
        ContextCompat.registerReceiver(
            getContext(),
            installReceiver,
            new IntentFilter(INSTALL_STATUS_ACTION),
            ContextCompat.RECEIVER_NOT_EXPORTED
        );
        receiversRegistered = true;
    }

    @SuppressWarnings("deprecation")
    private Intent getParcelableIntent(Intent source) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            return source.getParcelableExtra(Intent.EXTRA_INTENT, Intent.class);
        }
        return source.getParcelableExtra(Intent.EXTRA_INTENT);
    }

    private void cancelCurrentDownload() {
        mainHandler.removeCallbacks(progressPoller);
        if (downloadId != NO_DOWNLOAD && downloadManager != null) {
            downloadManager.remove(downloadId);
        }
        downloadId = NO_DOWNLOAD;
        if (filePath != null) {
            File oldFile = new File(filePath);
            if (oldFile.isFile()) {
                oldFile.delete();
            }
        }
    }

    private synchronized void updateState(String nextStatus, int nextProgress, String nextErrorCode) {
        status = nextStatus;
        progress = Math.max(0, Math.min(100, nextProgress));
        errorCode = nextErrorCode;
        persistState();
        JSObject event = stateResult();
        mainHandler.post(() -> notifyListeners("stateChanged", event));
    }

    private void fail(String code) {
        updateState("error", 0, code == null ? "update-failed" : code);
    }

    private synchronized JSObject stateResult() {
        JSObject result = new JSObject();
        result.put("status", status);
        result.put("progress", progress);
        result.put("version", version);
        result.put("error", errorCode);
        return result;
    }

    private synchronized void persistState() {
        if (preferences == null) {
            return;
        }
        preferences
            .edit()
            .putLong("downloadId", downloadId)
            .putString("version", version)
            .putString("url", url)
            .putString("sha256", expectedSha256)
            .putLong("size", expectedSize)
            .putString("filePath", filePath)
            .putString("status", status)
            .putInt("progress", progress)
            .putString("error", errorCode)
            .apply();
    }

    private synchronized void restoreState() {
        downloadId = preferences.getLong("downloadId", NO_DOWNLOAD);
        version = preferences.getString("version", null);
        url = preferences.getString("url", null);
        expectedSha256 = preferences.getString("sha256", null);
        expectedSize = preferences.getLong("size", 0);
        filePath = preferences.getString("filePath", null);
        status = preferences.getString("status", "idle");
        progress = preferences.getInt("progress", 0);
        errorCode = preferences.getString("error", null);
    }

    private synchronized void clearPersistedUpdate() {
        downloadId = NO_DOWNLOAD;
        version = null;
        url = null;
        expectedSha256 = null;
        expectedSize = 0;
        filePath = null;
        errorCode = null;
        preferences.edit().clear().apply();
    }

    private static class VerificationException extends Exception {
        VerificationException(String message) {
            super(message);
        }
    }
}

package io.github.isnothingness.chatboxpure;

import android.content.Context;
import android.content.res.Configuration;
import android.os.Bundle;
import android.view.View;
import android.view.Window;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    private static final String SYSTEM_UI_PREFERENCES = "chatbox_pure_system_ui";
    private static final String DARK_STATUS_BAR_ICONS = "dark_status_bar_icons";
    private static final long[] STATUS_BAR_RETRY_DELAYS_MS = {
        0L, 16L, 80L, 180L, 360L, 700L, 1200L, 2000L, 3200L
    };
    private boolean darkStatusBarIcons;
    private int statusBarRefreshGeneration;
    private static volatile boolean appVisible;

    public static boolean isAppVisible() {
        return appVisible;
    }

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(ScreenGeometryPlugin.class);
        registerPlugin(SystemThemePlugin.class);
        registerPlugin(AppUpdatePlugin.class);
        registerPlugin(PureStreamHttpPlugin.class);
        super.onCreate(savedInstanceState);

        boolean systemDark =
            (getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK)
                == Configuration.UI_MODE_NIGHT_YES;
        darkStatusBarIcons = getSharedPreferences(SYSTEM_UI_PREFERENCES, Context.MODE_PRIVATE)
            .getBoolean(DARK_STATUS_BAR_ICONS, !systemDark);
        refreshStatusBarIconStyle();
    }

    public void setStatusBarDarkIcons(boolean darkIcons) {
        darkStatusBarIcons = darkIcons;
        getSharedPreferences(SYSTEM_UI_PREFERENCES, Context.MODE_PRIVATE)
            .edit()
            .putBoolean(DARK_STATUS_BAR_ICONS, darkIcons)
            .apply();
        refreshStatusBarIconStyle();
    }

    @Override
    public void onResume() {
        super.onResume();
        refreshStatusBarIconStyle();
    }

    @Override
    public void onStart() {
        super.onStart();
        appVisible = true;
        BackgroundGenerationService.clearCompletionNotifications(this);
    }

    @Override
    public void onStop() {
        appVisible = false;
        super.onStop();
    }

    @Override
    protected void onPostResume() {
        super.onPostResume();
        refreshStatusBarIconStyle();
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) {
            refreshStatusBarIconStyle();
        }
    }

    @Override
    public void onConfigurationChanged(Configuration newConfig) {
        super.onConfigurationChanged(newConfig);
        refreshStatusBarIconStyle();
    }

    private void refreshStatusBarIconStyle() {
        int generation = ++statusBarRefreshGeneration;
        Window window = getWindow();
        if (window == null) {
            return;
        }
        View decorView = window.getDecorView();
        for (long delayMs : STATUS_BAR_RETRY_DELAYS_MS) {
            Runnable applyStyle = () -> {
                if (generation == statusBarRefreshGeneration) {
                    applyStatusBarIconStyleNow();
                }
            };
            if (delayMs == 0L) {
                applyStyle.run();
            } else {
                decorView.postDelayed(applyStyle, delayMs);
            }
        }
    }

    private void applyStatusBarIconStyleNow() {
        Window window = getWindow();
        if (window == null) {
            return;
        }

        View decorView = window.getDecorView();
        WindowInsetsControllerCompat controller = WindowCompat.getInsetsController(window, decorView);
        controller.setAppearanceLightStatusBars(darkStatusBarIcons);
        ViewCompat.requestApplyInsets(decorView);
        decorView.postInvalidateOnAnimation();
    }
}

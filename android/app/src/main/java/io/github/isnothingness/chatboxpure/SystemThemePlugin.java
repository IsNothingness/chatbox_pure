package io.github.isnothingness.chatboxpure;

import android.content.res.Configuration;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "SystemTheme")
public class SystemThemePlugin extends Plugin {
    private boolean lastKnownDark;

    @Override
    public void load() {
        lastKnownDark = isDark(getContext().getResources().getConfiguration());
    }

    @PluginMethod
    public void getCurrentTheme(PluginCall call) {
        boolean dark = isDark(getContext().getResources().getConfiguration());
        lastKnownDark = dark;
        call.resolve(themeResult(dark));
    }

    @PluginMethod
    public void setStatusBarStyle(PluginCall call) {
        boolean darkIcons = Boolean.TRUE.equals(call.getBoolean("darkIcons", false));
        getActivity().runOnUiThread(() -> {
            ((MainActivity) getActivity()).setStatusBarDarkIcons(darkIcons);
            call.resolve();
        });
    }

    @Override
    protected void handleOnConfigurationChanged(Configuration newConfig) {
        boolean dark = isDark(newConfig);
        if (dark == lastKnownDark) {
            return;
        }

        lastKnownDark = dark;
        notifyListeners("systemThemeChanged", themeResult(dark));
    }

    private boolean isDark(Configuration configuration) {
        return (configuration.uiMode & Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES;
    }

    private JSObject themeResult(boolean dark) {
        JSObject result = new JSObject();
        result.put("dark", dark);
        return result;
    }
}

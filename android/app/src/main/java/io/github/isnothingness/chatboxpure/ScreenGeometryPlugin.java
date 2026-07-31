package io.github.isnothingness.chatboxpure;

import android.graphics.Insets;
import android.os.Build;
import android.view.RoundedCorner;
import android.view.View;
import android.view.WindowInsets;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "ScreenGeometry")
public class ScreenGeometryPlugin extends Plugin {
    @PluginMethod
    public void getRoundedCorners(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            JSObject result = new JSObject();
            result.put("supported", Build.VERSION.SDK_INT >= Build.VERSION_CODES.S);

            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) {
                putFallbackCorners(result);
                call.resolve(result);
                return;
            }

            View decorView = getActivity().getWindow().getDecorView();
            WindowInsets windowInsets = decorView.getRootWindowInsets();
            if (windowInsets == null) {
                putFallbackCorners(result);
                call.resolve(result);
                return;
            }

            float density = getContext().getResources().getDisplayMetrics().density;
            result.put("topLeft", radiusInCssPixels(windowInsets, RoundedCorner.POSITION_TOP_LEFT, density));
            result.put("topRight", radiusInCssPixels(windowInsets, RoundedCorner.POSITION_TOP_RIGHT, density));
            result.put("bottomRight", radiusInCssPixels(windowInsets, RoundedCorner.POSITION_BOTTOM_RIGHT, density));
            result.put("bottomLeft", radiusInCssPixels(windowInsets, RoundedCorner.POSITION_BOTTOM_LEFT, density));
            call.resolve(result);
        });
    }

    @PluginMethod
    public void getSystemGestureInsets(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            JSObject result = new JSObject();
            View decorView = getActivity().getWindow().getDecorView();
            WindowInsets windowInsets = decorView.getRootWindowInsets();
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q || windowInsets == null) {
                putSystemGestureInsets(result, 0, 0, 0, 0);
                call.resolve(result);
                return;
            }

            float density = getContext().getResources().getDisplayMetrics().density;
            Insets insets = windowInsets.getSystemGestureInsets();
            putSystemGestureInsets(
                result,
                insets.left / density,
                insets.top / density,
                insets.right / density,
                insets.bottom / density
            );
            call.resolve(result);
        });
    }

    private double radiusInCssPixels(WindowInsets insets, int position, float density) {
        RoundedCorner corner = insets.getRoundedCorner(position);
        return corner == null ? 0 : corner.getRadius() / density;
    }

    private void putFallbackCorners(JSObject result) {
        result.put("topLeft", 0);
        result.put("topRight", 0);
        result.put("bottomRight", 0);
        result.put("bottomLeft", 0);
    }

    private void putSystemGestureInsets(JSObject result, double left, double top, double right, double bottom) {
        result.put("left", left);
        result.put("top", top);
        result.put("right", right);
        result.put("bottom", bottom);
        result.put("edgeNavigation", left > 0 || right > 0);
    }
}

package io.github.isnothingness.chatboxpure;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(ScreenGeometryPlugin.class);
        super.onCreate(savedInstanceState);
    }
}

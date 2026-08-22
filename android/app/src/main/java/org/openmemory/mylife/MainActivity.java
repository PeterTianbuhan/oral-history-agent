package org.openmemory.mylife;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(AppSettingsPlugin.class);
        registerPlugin(RealtimeRecorderPlugin.class);
        super.onCreate(savedInstanceState);
    }
}

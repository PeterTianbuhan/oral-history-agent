package org.openmemory.mylife;

import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import com.getcapacitor.JSObject;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

@CapacitorPlugin(name = "AppSettings")
public class AppSettingsPlugin extends com.getcapacitor.Plugin {
    private static final String KEY_ALIAS = "my-life-community-settings-key";
    private static final String PREFERENCES = "my-life-community-secure-settings";
    private static final String SETTINGS_VALUE = "encrypted-settings";

    @PluginMethod
    public synchronized void load(PluginCall call) {
        try {
            String encrypted = preferences().getString(SETTINGS_VALUE, "");
            JSObject result = new JSObject();
            result.put("value", encrypted.isEmpty() ? "" : decrypt(encrypted));
            call.resolve(result);
        } catch (Exception error) {
            call.reject("Unable to read secure settings.", error);
        }
    }

    @PluginMethod
    public synchronized void save(PluginCall call) {
        String value = call.getString("value", "");
        try {
            preferences().edit().putString(SETTINGS_VALUE, encrypt(value)).apply();
            call.resolve();
        } catch (Exception error) {
            call.reject("Unable to save secure settings.", error);
        }
    }

    @PluginMethod
    public synchronized void clear(PluginCall call) {
        preferences().edit().remove(SETTINGS_VALUE).apply();
        call.resolve();
    }

    private SharedPreferences preferences() {
        return getContext().getSharedPreferences(PREFERENCES, android.content.Context.MODE_PRIVATE);
    }

    private SecretKey secretKey() throws Exception {
        KeyStore keyStore = KeyStore.getInstance("AndroidKeyStore");
        keyStore.load(null);
        java.security.Key existing = keyStore.getKey(KEY_ALIAS, null);
        if (existing instanceof SecretKey) return (SecretKey) existing;

        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generator.init(new KeyGenParameterSpec.Builder(
            KEY_ALIAS,
            KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT
        )
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .build());
        return generator.generateKey();
    }

    private String encrypt(String value) throws Exception {
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, secretKey());
        byte[] encrypted = cipher.doFinal(value.getBytes(StandardCharsets.UTF_8));
        byte[] iv = cipher.getIV();
        ByteBuffer packed = ByteBuffer.allocate(4 + iv.length + encrypted.length);
        packed.putInt(iv.length);
        packed.put(iv);
        packed.put(encrypted);
        return Base64.encodeToString(packed.array(), Base64.NO_WRAP);
    }

    private String decrypt(String encoded) throws Exception {
        ByteBuffer packed = ByteBuffer.wrap(Base64.decode(encoded, Base64.NO_WRAP));
        int ivLength = packed.getInt();
        if (ivLength < 12 || ivLength > 32 || packed.remaining() <= ivLength) {
            throw new IllegalArgumentException("Invalid secure settings payload.");
        }
        byte[] iv = new byte[ivLength];
        packed.get(iv);
        byte[] encrypted = new byte[packed.remaining()];
        packed.get(encrypted);
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, secretKey(), new GCMParameterSpec(128, iv));
        return new String(cipher.doFinal(encrypted), StandardCharsets.UTF_8);
    }
}

package org.openmemory.mylife;

import android.Manifest;
import android.media.AudioFormat;
import android.media.AudioRecord;
import android.media.MediaRecorder;
import android.net.Uri;
import android.os.Process;
import android.os.SystemClock;
import android.util.Base64;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import java.io.File;
import java.io.IOException;
import java.io.RandomAccessFile;
import java.util.ArrayDeque;
import java.util.UUID;
import java.util.concurrent.TimeUnit;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;
import org.json.JSONException;
import org.json.JSONObject;

@CapacitorPlugin(
    name = "RealtimeRecorder",
    permissions = { @Permission(alias = "microphone", strings = { Manifest.permission.RECORD_AUDIO }) }
)
public class RealtimeRecorderPlugin extends com.getcapacitor.Plugin {

    private static final int CHANNELS = 1;
    private static final int BITS_PER_SAMPLE = 16;
    private static final int BYTES_PER_SAMPLE = BITS_PER_SAMPLE / 8;
    private static final String QWEN_ASR_BASE_URL =
        "wss://dashscope.aliyuncs.com/api-ws/v1/realtime?model=";

    private final Object recordingLock = new Object();
    private final Object asrLock = new Object();
    private final ArrayDeque<String> pendingAsrCommits = new ArrayDeque<>();
    private final OkHttpClient asrClient = new OkHttpClient.Builder()
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .pingInterval(20, TimeUnit.SECONDS)
        .build();
    private AudioRecord audioRecord;
    private Thread captureThread;
    private RandomAccessFile wavFile;
    private File activeFile;
    private volatile boolean recording = false;
    private int sampleRate = 16000;
    private int samplesPerChunk = 1600;
    private long dataBytes = 0;
    private double currentAmplitude = 0;
    private WebSocket asrSocket;
    private PluginCall asrStartCall;
    private boolean asrReady = false;
    private boolean asrFinishing = false;
    private long asrUncommittedBytes = 0;
    private String asrLanguage = "";

    @PluginMethod
    public void checkPermissions(PluginCall call) {
        JSObject result = new JSObject();
        result.put("recordAudio", permissionString(getPermissionState("microphone")));
        call.resolve(result);
    }

    @PluginMethod
    public void requestPermissions(PluginCall call) {
        if (getPermissionState("microphone") == PermissionState.GRANTED) {
            JSObject result = new JSObject();
            result.put("recordAudio", "granted");
            call.resolve(result);
            return;
        }
        requestPermissionForAlias("microphone", call, "microphonePermissionCallback");
    }

    @PermissionCallback
    public void microphonePermissionCallback(PluginCall call) {
        JSObject result = new JSObject();
        result.put("recordAudio", permissionString(getPermissionState("microphone")));
        call.resolve(result);
    }

    @PluginMethod
    public void startAsr(PluginCall call) {
        String provider = call.getString("provider", "");
        String apiKey = call.getString("apiKey", "").trim();
        String requestedModel = call.getString("model", "qwen3-asr-flash-realtime");
        String requestedLanguage = call.getString("language", "auto");
        if (!provider.equals("qwen-native-direct")) {
            call.reject("Unsupported Android speech provider.");
            return;
        }
        if (apiKey.isEmpty()) {
            call.reject("No speech API key configured.");
            return;
        }
        String model = requestedModel.replaceAll("[^a-zA-Z0-9._-]", "");
        if (model.isEmpty()) model = "qwen3-asr-flash-realtime";

        synchronized (asrLock) {
            if (asrSocket != null) {
                call.reject("ASR session already active.");
                return;
            }
            asrReady = false;
            asrFinishing = false;
            asrUncommittedBytes = 0;
            pendingAsrCommits.clear();
            asrStartCall = call;
            asrLanguage = requestedLanguage.equals("auto") ? "" : requestedLanguage;

            Request request = new Request.Builder()
                .url(QWEN_ASR_BASE_URL + model)
                .header("Authorization", "Bearer " + apiKey)
                .build();
            asrSocket = asrClient.newWebSocket(request, new WebSocketListener() {
                @Override
                public void onMessage(WebSocket webSocket, String text) {
                    handleAsrMessage(webSocket, text);
                }

                @Override
                public void onFailure(WebSocket webSocket, Throwable error, Response response) {
                    failAsr("asr-connection-failed", "暂时无法连接实时转录服务");
                }

                @Override
                public void onClosed(WebSocket webSocket, int code, String reason) {
                    boolean expected;
                    synchronized (asrLock) {
                        expected = asrFinishing || asrSocket == null;
                        clearAsrLocked();
                    }
                    if (!expected) emitAsrError("asr-connection-closed", "实时转录连接已中断");
                }
            });
        }
    }

    @PluginMethod
    public void commitAsr(PluginCall call) {
        String requestId = safeRequestId(call.getString("requestId"));
        synchronized (asrLock) {
            if (!asrReady || asrSocket == null) {
                call.reject("ASR session is not ready.");
                return;
            }
            if (asrUncommittedBytes == 0) {
                JSObject result = new JSObject();
                result.put("committed", false);
                call.resolve(result);
                return;
            }
            pendingAsrCommits.add(requestId);
            if (!asrSocket.send(clientEvent("input_audio_buffer.commit"))) {
                pendingAsrCommits.removeLastOccurrence(requestId);
                call.reject("Unable to commit ASR segment.");
                return;
            }
            asrUncommittedBytes = 0;
            JSObject result = new JSObject();
            result.put("committed", true);
            result.put("requestId", requestId);
            call.resolve(result);
        }
    }

    @PluginMethod
    public void finishAsr(PluginCall call) {
        synchronized (asrLock) {
            if (asrSocket == null) {
                call.resolve();
                return;
            }
            asrFinishing = true;
            if (!asrSocket.send(clientEvent("session.finish"))) {
                call.reject("Unable to finish ASR session.");
                return;
            }
        }
        call.resolve();
    }

    @PluginMethod
    public void abortAsr(PluginCall call) {
        PluginCall pendingStart;
        synchronized (asrLock) {
            pendingStart = asrStartCall;
            asrStartCall = null;
            if (asrSocket != null) asrSocket.close(1000, "client-aborted");
            clearAsrLocked();
        }
        if (pendingStart != null) pendingStart.reject("ASR session aborted.");
        call.resolve();
    }

    @PluginMethod
    public void startRecording(PluginCall call) {
        if (getPermissionState("microphone") != PermissionState.GRANTED) {
            call.reject("Microphone permission not granted.");
            return;
        }

        int requestedSampleRate = call.getInt("sampleRate", 16000);
        int chunkMilliseconds = call.getInt("chunkMilliseconds", 100);
        if (requestedSampleRate != 16000) {
            call.reject("Only 16000 Hz PCM is supported.");
            return;
        }
        chunkMilliseconds = Math.max(40, Math.min(chunkMilliseconds, 200));

        synchronized (recordingLock) {
            if (recording) {
                call.reject("Recording already in progress.");
                return;
            }
            if (audioRecord != null || wavFile != null) releaseRecorderLocked(true);
            sampleRate = requestedSampleRate;
            samplesPerChunk = Math.max(1, sampleRate * chunkMilliseconds / 1000);
            int minimumBuffer = AudioRecord.getMinBufferSize(
                sampleRate,
                AudioFormat.CHANNEL_IN_MONO,
                AudioFormat.ENCODING_PCM_16BIT
            );
            if (minimumBuffer <= 0) {
                call.reject("This device does not support 16 kHz PCM recording.");
                return;
            }

            try {
                int recorderBuffer = Math.max(minimumBuffer, samplesPerChunk * BYTES_PER_SAMPLE * 2);
                audioRecord = new AudioRecord(
                    MediaRecorder.AudioSource.VOICE_RECOGNITION,
                    sampleRate,
                    AudioFormat.CHANNEL_IN_MONO,
                    AudioFormat.ENCODING_PCM_16BIT,
                    recorderBuffer
                );
                if (audioRecord.getState() != AudioRecord.STATE_INITIALIZED) {
                    throw new IOException("AudioRecord initialization failed.");
                }
                openNextSegmentLocked();
                audioRecord.startRecording();
                recording = true;
                currentAmplitude = 0;
            } catch (Exception error) {
                releaseRecorderLocked(true);
                call.reject("Unable to start PCM recording.", error);
                return;
            }
        }

        captureThread = new Thread(this::captureLoop, "my-life-pcm-recorder");
        captureThread.start();
        call.resolve();
    }

    @PluginMethod
    public void cutSegment(PluginCall call) {
        synchronized (recordingLock) {
            if (!recording || wavFile == null) {
                call.reject("No active recording to cut.");
                return;
            }
            try {
                JSObject result = finalizeSegmentLocked(call.getString("segmentId"));
                openNextSegmentLocked();
                call.resolve(result);
            } catch (IOException error) {
                call.reject("Unable to save this recording segment.", error);
            }
        }
    }

    @PluginMethod
    public void stopRecording(PluginCall call) {
        synchronized (recordingLock) {
            if (audioRecord == null || wavFile == null) {
                call.reject("No active recording to stop.");
                return;
            }
            recording = false;
            try {
                audioRecord.stop();
            } catch (IllegalStateException ignored) {}
        }

        joinCaptureThread();
        synchronized (recordingLock) {
            try {
                JSObject result = finalizeSegmentLocked(call.getString("segmentId"));
                releaseRecorderLocked(false);
                call.resolve(result);
            } catch (IOException error) {
                releaseRecorderLocked(false);
                call.reject("Unable to save the final recording segment.", error);
            }
        }
    }

    @PluginMethod
    public void cancelRecording(PluginCall call) {
        stopCapture();
        synchronized (recordingLock) {
            releaseRecorderLocked(true);
        }
        call.resolve();
    }

    @PluginMethod
    public void getCurrentAmplitude(PluginCall call) {
        JSObject result = new JSObject();
        result.put("value", recording ? currentAmplitude : 0);
        call.resolve(result);
    }

    @Override
    protected void handleOnDestroy() {
        stopCapture();
        synchronized (recordingLock) {
            releaseRecorderLocked(true);
        }
        synchronized (asrLock) {
            if (asrSocket != null) asrSocket.close(1000, "plugin-destroyed");
            clearAsrLocked();
        }
        super.handleOnDestroy();
    }

    private void captureLoop() {
        Process.setThreadPriority(Process.THREAD_PRIORITY_AUDIO);
        short[] samples = new short[samplesPerChunk];
        byte[] pcm = new byte[samplesPerChunk * BYTES_PER_SAMPLE];

        while (recording) {
            synchronized (recordingLock) {
                if (!recording || audioRecord == null || wavFile == null) break;
                int count = audioRecord.read(samples, 0, samples.length, AudioRecord.READ_BLOCKING);
                if (count <= 0) {
                    if (recording) notifyRecordingError("Audio capture failed.");
                    continue;
                }

                int peak = 0;
                for (int index = 0; index < count; index++) {
                    short sample = samples[index];
                    peak = Math.max(peak, Math.abs((int) sample));
                    pcm[index * 2] = (byte) (sample & 0xff);
                    pcm[index * 2 + 1] = (byte) ((sample >> 8) & 0xff);
                }

                int byteCount = count * BYTES_PER_SAMPLE;
                try {
                    wavFile.write(pcm, 0, byteCount);
                    dataBytes += byteCount;
                } catch (IOException error) {
                    notifyRecordingError("Unable to write recording evidence.");
                    recording = false;
                    break;
                }
                currentAmplitude = Math.min(1.0, peak / 32767.0);

                String encoded = Base64.encodeToString(pcm, 0, byteCount, Base64.NO_WRAP);
                sendAudioToAsr(encoded, byteCount);
            }
        }
    }

    private void stopCapture() {
        synchronized (recordingLock) {
            recording = false;
            if (audioRecord != null) {
                try {
                    audioRecord.stop();
                } catch (IllegalStateException ignored) {}
            }
        }
        joinCaptureThread();
    }

    private void joinCaptureThread() {
        Thread thread = captureThread;
        captureThread = null;
        if (thread == null || thread == Thread.currentThread()) return;
        try {
            thread.join(2000);
        } catch (InterruptedException error) {
            Thread.currentThread().interrupt();
        }
    }

    private void openNextSegmentLocked() throws IOException {
        File directory = evidenceDirectory();
        activeFile = File.createTempFile("active-", ".wav", directory);
        wavFile = new RandomAccessFile(activeFile, "rw");
        wavFile.setLength(0);
        writeWavHeader(wavFile, 0, sampleRate);
        dataBytes = 0;
    }

    private JSObject finalizeSegmentLocked(String requestedSegmentId) throws IOException {
        if (wavFile == null || activeFile == null) throw new IOException("No active evidence file.");
        long segmentBytes = dataBytes;
        writeWavHeader(wavFile, segmentBytes, sampleRate);
        wavFile.getFD().sync();
        wavFile.close();
        wavFile = null;

        String safeId = safeSegmentId(requestedSegmentId);
        File destination = uniqueDestination(safeId);
        if (!activeFile.renameTo(destination)) destination = activeFile;
        activeFile = null;
        dataBytes = 0;

        JSObject result = new JSObject();
        result.put("uri", Uri.fromFile(destination).toString());
        result.put("duration", Math.round(segmentBytes * 1000.0 / (sampleRate * CHANNELS * BYTES_PER_SAMPLE)));
        return result;
    }

    private File evidenceDirectory() throws IOException {
        File directory = new File(getContext().getFilesDir(), "memory/evidence");
        if (!directory.exists() && !directory.mkdirs()) {
            throw new IOException("Unable to create evidence directory.");
        }
        return directory;
    }

    private File uniqueDestination(String safeId) throws IOException {
        File directory = evidenceDirectory();
        File destination = new File(directory, safeId + ".wav");
        if (!destination.exists()) return destination;
        return new File(directory, safeId + "-" + SystemClock.elapsedRealtime() + ".wav");
    }

    private void releaseRecorderLocked(boolean deleteActiveFile) {
        recording = false;
        currentAmplitude = 0;
        if (wavFile != null) {
            try {
                wavFile.close();
            } catch (IOException ignored) {}
        }
        wavFile = null;
        if (deleteActiveFile && activeFile != null && activeFile.exists()) {
            //noinspection ResultOfMethodCallIgnored
            activeFile.delete();
        }
        activeFile = null;
        dataBytes = 0;
        if (audioRecord != null) {
            try {
                audioRecord.stop();
            } catch (IllegalStateException ignored) {}
            audioRecord.release();
            audioRecord = null;
        }
    }

    private void sendAudioToAsr(String audio, int byteCount) {
        synchronized (asrLock) {
            if (!asrReady || asrSocket == null) return;
            try {
                JSONObject event = new JSONObject();
                event.put("event_id", UUID.randomUUID().toString());
                event.put("type", "input_audio_buffer.append");
                event.put("audio", audio);
                if (asrSocket.send(event.toString())) asrUncommittedBytes += byteCount;
            } catch (JSONException ignored) {}
        }
    }

    private void handleAsrMessage(WebSocket webSocket, String text) {
        try {
            JSONObject event = new JSONObject(text);
            String type = event.optString("type", "");
            if (type.equals("session.created")) {
                webSocket.send(sessionUpdateEvent());
                return;
            }
            if (type.equals("session.updated")) {
                PluginCall pendingStart;
                synchronized (asrLock) {
                    asrReady = true;
                    pendingStart = asrStartCall;
                    asrStartCall = null;
                }
                JSObject readyEvent = new JSObject();
                readyEvent.put("type", "ready");
                notifyListeners("asrEvent", readyEvent);
                if (pendingStart != null) pendingStart.resolve();
                return;
            }
            if (type.equals("conversation.item.input_audio_transcription.text")) {
                JSObject partial = new JSObject();
                partial.put("type", "partial");
                partial.put("text", event.optString("text", ""));
                partial.put("stash", event.optString("stash", ""));
                partial.put("itemId", event.optString("item_id", ""));
                notifyListeners("asrEvent", partial);
                return;
            }
            if (type.equals("input_audio_buffer.committed")) {
                JSObject committed = new JSObject();
                committed.put("type", "committed");
                synchronized (asrLock) {
                    committed.put("requestId", pendingAsrCommits.peek());
                }
                committed.put("itemId", event.optString("item_id", ""));
                notifyListeners("asrEvent", committed);
                return;
            }
            if (type.equals("conversation.item.input_audio_transcription.completed")) {
                JSObject completed = new JSObject();
                completed.put("type", "final");
                synchronized (asrLock) {
                    completed.put("requestId", pendingAsrCommits.poll());
                }
                completed.put("transcript", event.optString("transcript", ""));
                completed.put("itemId", event.optString("item_id", ""));
                notifyListeners("asrEvent", completed);
                return;
            }
            if (type.equals("session.finished")) {
                synchronized (asrLock) {
                    asrReady = false;
                    asrFinishing = true;
                }
                JSObject finished = new JSObject();
                finished.put("type", "finished");
                notifyListeners("asrEvent", finished);
                webSocket.close(1000, "session-finished");
                return;
            }
            if (type.equals("error") || type.equals("conversation.item.input_audio_transcription.failed")) {
                JSONObject details = event.optJSONObject("error");
                String code = details != null ? details.optString("code", "asr-failed") : event.optString("code", "asr-failed");
                String message = details != null
                    ? details.optString("message", "实时转录失败")
                    : event.optString("message", "实时转录失败");
                emitAsrError(code, message);
            }
        } catch (JSONException error) {
            emitAsrError("invalid-asr-response", "转录服务返回了无法读取的消息");
        }
    }

    private String sessionUpdateEvent() throws JSONException {
        JSONObject transcription = new JSONObject();
        if (!asrLanguage.isEmpty()) transcription.put("language", asrLanguage);
        JSONObject session = new JSONObject();
        session.put("input_audio_format", "pcm");
        session.put("sample_rate", 16000);
        session.put("input_audio_transcription", transcription);
        session.put("turn_detection", JSONObject.NULL);
        JSONObject event = new JSONObject();
        event.put("event_id", UUID.randomUUID().toString());
        event.put("type", "session.update");
        event.put("session", session);
        return event.toString();
    }

    private String clientEvent(String type) {
        try {
            JSONObject event = new JSONObject();
            event.put("event_id", UUID.randomUUID().toString());
            event.put("type", type);
            return event.toString();
        } catch (JSONException ignored) {
            return "{}";
        }
    }

    private void failAsr(String code, String message) {
        PluginCall pendingStart;
        synchronized (asrLock) {
            pendingStart = asrStartCall;
            asrStartCall = null;
            clearAsrLocked();
        }
        if (pendingStart != null) pendingStart.reject(message);
        emitAsrError(code, message);
    }

    private void emitAsrError(String code, String message) {
        JSObject error = new JSObject();
        error.put("type", "error");
        error.put("code", code);
        error.put("message", message);
        notifyListeners("asrEvent", error);
    }

    private void clearAsrLocked() {
        asrSocket = null;
        asrStartCall = null;
        asrReady = false;
        asrFinishing = false;
        asrUncommittedBytes = 0;
        pendingAsrCommits.clear();
        asrLanguage = "";
    }

    private String safeRequestId(String value) {
        if (value == null || value.isEmpty()) return UUID.randomUUID().toString();
        String safe = value.replaceAll("[^a-zA-Z0-9-]", "-");
        return safe.substring(0, Math.min(safe.length(), 120));
    }

    private void notifyRecordingError(String message) {
        JSObject error = new JSObject();
        error.put("message", message);
        notifyListeners("recordingError", error);
    }

    private String safeSegmentId(String value) {
        String candidate = value == null ? "memory-" + System.currentTimeMillis() : value;
        candidate = candidate.replaceAll("[^a-zA-Z0-9-]", "-");
        if (candidate.isEmpty()) candidate = "memory-" + System.currentTimeMillis();
        return candidate.substring(0, Math.min(candidate.length(), 120));
    }

    private String permissionString(PermissionState state) {
        if (state == PermissionState.GRANTED) return "granted";
        if (state == PermissionState.DENIED) return "denied";
        if (state == PermissionState.PROMPT_WITH_RATIONALE) return "prompt-with-rationale";
        return "prompt";
    }

    private static void writeWavHeader(RandomAccessFile file, long dataLength, int rate) throws IOException {
        long safeLength = Math.min(dataLength, 0xffffffffL - 36);
        file.seek(0);
        file.writeBytes("RIFF");
        writeIntLittleEndian(file, 36 + safeLength);
        file.writeBytes("WAVE");
        file.writeBytes("fmt ");
        writeIntLittleEndian(file, 16);
        writeShortLittleEndian(file, 1);
        writeShortLittleEndian(file, CHANNELS);
        writeIntLittleEndian(file, rate);
        writeIntLittleEndian(file, (long) rate * CHANNELS * BYTES_PER_SAMPLE);
        writeShortLittleEndian(file, CHANNELS * BYTES_PER_SAMPLE);
        writeShortLittleEndian(file, BITS_PER_SAMPLE);
        file.writeBytes("data");
        writeIntLittleEndian(file, safeLength);
        file.seek(44 + dataLength);
    }

    private static void writeIntLittleEndian(RandomAccessFile file, long value) throws IOException {
        file.write((int) (value & 0xff));
        file.write((int) ((value >> 8) & 0xff));
        file.write((int) ((value >> 16) & 0xff));
        file.write((int) ((value >> 24) & 0xff));
    }

    private static void writeShortLittleEndian(RandomAccessFile file, int value) throws IOException {
        file.write(value & 0xff);
        file.write((value >> 8) & 0xff);
    }
}

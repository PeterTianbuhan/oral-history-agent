import { Capacitor, registerPlugin } from '@capacitor/core';

const RealtimeRecorder = registerPlugin('RealtimeRecorder');

export const hasNativeRecorder = Capacitor.isNativePlatform();

async function ensureMicrophonePermission() {
  const current = await RealtimeRecorder.checkPermissions();
  if (current.recordAudio === 'granted') return;

  const requested = await RealtimeRecorder.requestPermissions();
  if (requested.recordAudio !== 'granted') {
    throw new Error('microphone-permission-denied');
  }
}

function recordingResult(result) {
  return {
    audioUri: result?.uri ?? null,
    durationMs: result?.duration ?? null,
    storage: result?.uri ? 'app-data' : 'missing',
    persistenceError: !result?.uri,
  };
}

export async function addDeviceAsrListener(listener) {
  if (!hasNativeRecorder) return { remove: async () => {} };
  return RealtimeRecorder.addListener('asrEvent', listener);
}

export async function startDeviceAsr(config = {}) {
  if (!hasNativeRecorder) return null;
  return RealtimeRecorder.startAsr({
    provider: config.provider,
    apiKey: config.apiKey,
    model: config.model,
    language: config.language,
  });
}

export async function commitDeviceAsr(requestId) {
  if (!hasNativeRecorder) return { committed: false };
  return RealtimeRecorder.commitAsr({ requestId });
}

export async function finishDeviceAsr() {
  if (!hasNativeRecorder) return;
  await RealtimeRecorder.finishAsr();
}

export async function abortDeviceAsr() {
  if (!hasNativeRecorder) return;
  await RealtimeRecorder.abortAsr();
}

export async function startDeviceRecording() {
  if (!hasNativeRecorder) return null;
  await ensureMicrophonePermission();
  await RealtimeRecorder.startRecording({
    sampleRate: 16000,
    chunkMilliseconds: 100,
  });
  return { startedAt: new Date().toISOString() };
}

export async function cutDeviceRecording(segmentId) {
  if (!hasNativeRecorder) return null;
  return recordingResult(await RealtimeRecorder.cutSegment({ segmentId }));
}

export async function stopDeviceRecording(segmentId) {
  if (!hasNativeRecorder) return null;
  return recordingResult(await RealtimeRecorder.stopRecording({ segmentId }));
}

export async function cancelDeviceRecording() {
  if (!hasNativeRecorder) return;
  await RealtimeRecorder.cancelRecording();
}

export async function readRecordingAmplitude() {
  if (!hasNativeRecorder) return 0;
  const result = await RealtimeRecorder.getCurrentAmplitude();
  return result.value ?? 0;
}

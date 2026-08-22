import { registerAsrProvider } from './asr-runtime.js';
import { qwenPartialText } from './transcript.js';
import {
  abortDeviceAsr,
  addDeviceAsrListener,
  commitDeviceAsr,
  finishDeviceAsr,
  hasNativeRecorder,
  startDeviceAsr,
} from '../platform/native-recorder.js';

const READY_TIMEOUT_MS = 15000;
const SEGMENT_TIMEOUT_MS = 35000;
const FINISH_TIMEOUT_MS = 10000;

function deferred(timeoutMs, timeoutError) {
  let resolve;
  let reject;
  const promise = new Promise((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  const timer = globalThis.setTimeout(() => reject(new Error(timeoutError)), timeoutMs);
  return {
    promise,
    resolve(value) {
      globalThis.clearTimeout(timer);
      resolve(value);
    },
    reject(error) {
      globalThis.clearTimeout(timer);
      reject(error);
    },
  };
}

function requestId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `asr-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function createQwenNativeSession({ config, onPartial, onFinal, onError }) {
  let listener = null;
  let closed = false;
  let finishWaiter = null;
  const pendingSegments = new Map();

  function normalizedError(value) {
    return value instanceof Error ? value : new Error(String(value));
  }

  function rejectPending(error) {
    for (const pending of pendingSegments.values()) pending.reject(error);
    pendingSegments.clear();
  }

  function handleEvent(event) {
    if (event.type === 'partial') {
      onPartial?.({
        text: qwenPartialText(event),
        stableText: event.text ?? '',
        draftText: event.stash ?? '',
      });
      return;
    }
    if (event.type === 'final') {
      const transcript = typeof event.transcript === 'string' ? event.transcript.trim() : '';
      const pending = pendingSegments.get(event.requestId)
        ?? pendingSegments.values().next().value;
      if (event.requestId) pendingSegments.delete(event.requestId);
      else if (pending) pendingSegments.delete(pendingSegments.keys().next().value);
      onFinal?.({ text: transcript });
      pending?.resolve(transcript);
      return;
    }
    if (event.type === 'finished') {
      finishWaiter?.resolve();
      return;
    }
    if (event.type === 'error') {
      const error = normalizedError(event.message || event.code || 'asr-native-error');
      onError?.(error);
      finishWaiter?.reject(error);
      rejectPending(error);
    }
  }

  async function cleanup() {
    if (closed) return;
    closed = true;
    if (listener) {
      await listener.remove();
      listener = null;
    }
  }

  async function start() {
    if (!hasNativeRecorder) throw new Error('asr-native-recorder-required');
    listener = await addDeviceAsrListener(handleEvent);
    const timeout = deferred(READY_TIMEOUT_MS, 'asr-ready-timeout');
    try {
      await Promise.race([
        startDeviceAsr(config),
        timeout.promise,
      ]);
      timeout.resolve();
    } catch (error) {
      timeout.resolve();
      await abortDeviceAsr().catch(() => {});
      await cleanup();
      throw error;
    }
  }

  async function cutSegment() {
    if (closed) return '';
    const id = requestId();
    const pending = deferred(SEGMENT_TIMEOUT_MS, 'asr-segment-timeout');
    pendingSegments.set(id, pending);
    try {
      const result = await commitDeviceAsr(id);
      if (!result?.committed) {
        pending.resolve('');
        return '';
      }
      return await pending.promise;
    } finally {
      pendingSegments.delete(id);
    }
  }

  async function stop() {
    const transcript = await cutSegment();
    finishWaiter = deferred(FINISH_TIMEOUT_MS, 'asr-finish-timeout');
    await finishDeviceAsr();
    await finishWaiter.promise;
    await cleanup();
    return transcript;
  }

  async function abort() {
    rejectPending(new Error('asr-session-aborted'));
    finishWaiter?.resolve();
    await abortDeviceAsr().catch(() => {});
    await cleanup();
  }

  return { start, cutSegment, stop, abort };
}

registerAsrProvider(async (options) => {
  if (['qwen-native-direct', 'apple-speech'].includes(options.config?.provider)) {
    return createQwenNativeSession(options);
  }
  throw new Error(`unsupported-asr-provider:${options.config?.provider || 'missing'}`);
});

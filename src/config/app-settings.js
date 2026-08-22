import { Capacitor, registerPlugin } from '@capacitor/core';
import { settingsForAgentProvider } from './provider-presets.js';

const NativeAppSettings = registerPlugin('AppSettings');
const WEB_SETTINGS_KEY = 'my-life-community.app-settings.v1';
export const SUPPORTED_LOCALES = ['zh-CN', 'zh-TW', 'en'];

export function detectLocale(language = globalThis.navigator?.language) {
  const normalized = String(language ?? '').toLowerCase();
  if (normalized.startsWith('zh-tw') || normalized.startsWith('zh-hk') || normalized.startsWith('zh-hant')) {
    return 'zh-TW';
  }
  if (normalized.startsWith('zh')) return 'zh-CN';
  return 'en';
}

export function defaultAsrSettings(platform = Capacitor.getPlatform()) {
  if (platform === 'ios') {
    return {
      provider: 'apple-speech',
      apiKey: '',
      model: 'apple-speech',
      language: 'auto',
    };
  }
  return {
    provider: 'none',
    apiKey: '',
    model: '',
    language: 'auto',
  };
}

export function defaultAppSettings({ platform, language } = {}) {
  return {
    version: 1,
    onboardingComplete: false,
    locale: detectLocale(language),
    agent: settingsForAgentProvider('openrouter'),
    asr: defaultAsrSettings(platform),
  };
}

function normalizeString(value, fallback = '') {
  return typeof value === 'string' ? value.trim() : fallback;
}

export function normalizeAppSettings(value, options = {}) {
  const defaults = defaultAppSettings(options);
  if (!value || typeof value !== 'object') return defaults;
  const locale = SUPPORTED_LOCALES.includes(value.locale) ? value.locale : defaults.locale;
  const provider = ['openrouter', 'openai', 'aliyun', 'custom'].includes(value.agent?.provider)
    ? value.agent.provider
    : defaults.agent.provider;
  const preset = settingsForAgentProvider(provider);
  const asrProvider = ['none', 'apple-speech', 'qwen-native-direct'].includes(value.asr?.provider)
    ? value.asr.provider
    : defaults.asr.provider;

  return {
    version: 1,
    onboardingComplete: Boolean(value.onboardingComplete),
    locale,
    agent: {
      provider,
      apiKey: normalizeString(value.agent?.apiKey),
      baseUrl: normalizeString(value.agent?.baseUrl, preset.baseUrl),
      model: normalizeString(value.agent?.model, preset.model),
    },
    asr: {
      provider: asrProvider,
      apiKey: normalizeString(value.asr?.apiKey),
      model: normalizeString(
        value.asr?.model,
        asrProvider === 'qwen-native-direct' ? 'qwen3-asr-flash-realtime' : '',
      ),
      language: normalizeString(value.asr?.language, 'auto'),
    },
  };
}

async function loadNativeSettings() {
  const result = await NativeAppSettings.load();
  if (!result?.value) return null;
  return JSON.parse(result.value);
}

export async function loadAppSettings(options = {}) {
  try {
    const value = Capacitor.isNativePlatform()
      ? await loadNativeSettings()
      : JSON.parse(globalThis.localStorage?.getItem(WEB_SETTINGS_KEY) || 'null');
    return normalizeAppSettings(value, options);
  } catch (error) {
    console.error('Unable to load local app settings', error);
    return defaultAppSettings(options);
  }
}

export async function persistAppSettings(settings) {
  const normalized = normalizeAppSettings(settings);
  const value = JSON.stringify(normalized);
  if (Capacitor.isNativePlatform()) {
    await NativeAppSettings.save({ value });
  } else {
    globalThis.localStorage?.setItem(WEB_SETTINGS_KEY, value);
  }
  return normalized;
}

export async function clearAppSettings() {
  if (Capacitor.isNativePlatform()) {
    await NativeAppSettings.clear();
  } else {
    globalThis.localStorage?.removeItem(WEB_SETTINGS_KEY);
  }
}

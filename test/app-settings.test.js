import test from 'node:test';
import assert from 'node:assert/strict';
import {
  defaultAppSettings,
  detectLocale,
  normalizeAppSettings,
} from '../src/config/app-settings.js';
import {
  isAgentConfigured,
  isAsrConfigured,
  runtimeConfigFromSettings,
} from '../src/config/runtime-config.js';

test('public defaults contain no API key and recommend OpenRouter', () => {
  const settings = defaultAppSettings({ platform: 'android', language: 'zh-CN' });
  assert.equal(settings.agent.provider, 'openrouter');
  assert.equal(settings.agent.model, 'openrouter/auto');
  assert.equal(settings.agent.apiKey, '');
  assert.equal(settings.asr.apiKey, '');
  assert.equal(settings.onboardingComplete, false);
  assert.equal(isAgentConfigured(runtimeConfigFromSettings(settings)), false);
});

test('iPhone defaults to Apple Speech without a second API key', () => {
  const settings = defaultAppSettings({ platform: 'ios', language: 'en-US' });
  const runtime = runtimeConfigFromSettings(settings);
  assert.equal(settings.locale, 'en');
  assert.equal(runtime.asr.provider, 'apple-speech');
  assert.equal(isAsrConfigured(runtime), true);
});

test('Qwen speech requires its own configured key', () => {
  const base = defaultAppSettings({ platform: 'android' });
  const missing = runtimeConfigFromSettings({
    ...base,
    asr: { provider: 'qwen-native-direct', model: 'qwen3-asr-flash-realtime', apiKey: '' },
  });
  assert.equal(isAsrConfigured(missing), false);
  const ready = runtimeConfigFromSettings({
    ...base,
    asr: { ...missing.asr, apiKey: 'local-test-key' },
  });
  assert.equal(isAsrConfigured(ready), true);
});

test('locale detection and normalization support simplified, traditional, and English', () => {
  assert.equal(detectLocale('zh-Hant-HK'), 'zh-TW');
  assert.equal(detectLocale('zh-CN'), 'zh-CN');
  assert.equal(detectLocale('fr-FR'), 'en');
  assert.equal(normalizeAppSettings({ locale: 'not-real' }, { language: 'en-US' }).locale, 'en');
});

test('OpenRouter runtime preserves attribution headers but never invents a key', () => {
  const runtime = runtimeConfigFromSettings({
    ...defaultAppSettings(),
    agent: {
      provider: 'openrouter',
      apiKey: 'user-owned-key',
      model: 'anthropic/claude-sonnet-4',
      baseUrl: 'https://openrouter.ai/api/v1/',
    },
  });
  assert.equal(runtime.agent.baseUrl, 'https://openrouter.ai/api/v1');
  assert.equal(runtime.agent.model.id, 'anthropic/claude-sonnet-4');
  assert.equal(runtime.agent.model.headers['X-OpenRouter-Title'], 'My Life');
  assert.equal(isAgentConfigured(runtime), true);
});

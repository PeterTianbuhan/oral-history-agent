import { agentProviderPreset } from './provider-presets.js';

export function runtimeConfigFromSettings(settings) {
  const agentSettings = settings?.agent ?? {};
  const preset = agentProviderPreset(agentSettings.provider);
  const asrSettings = settings?.asr ?? {};
  const modelId = String(agentSettings.model ?? preset.model).trim();
  const baseUrl = String(agentSettings.baseUrl ?? preset.baseUrl).trim().replace(/\/+$/, '');

  return {
    locale: settings?.locale ?? 'zh-CN',
    agent: {
      enabled: Boolean(agentSettings.apiKey && modelId && baseUrl),
      transport: 'direct',
      baseUrl,
      apiKey: String(agentSettings.apiKey ?? '').trim(),
      thinkingLevel: 'high',
      initialReplyThinkingLevel: 'low',
      compactThinkingLevel: 'low',
      maxTurns: 12,
      model: {
        id: modelId,
        name: preset.modelName || modelId,
        api: 'openai-completions',
        provider: preset.provider,
        reasoning: preset.reasoning,
        contextWindow: preset.contextWindow,
        maxTokens: preset.maxTokens,
        ...(preset.compat ? { compat: preset.compat } : {}),
        ...(preset.headers ? { headers: preset.headers } : {}),
      },
    },
    asr: {
      enabled: asrSettings.provider !== 'none',
      provider: asrSettings.provider ?? 'none',
      apiKey: String(asrSettings.apiKey ?? '').trim(),
      model: String(asrSettings.model ?? '').trim(),
      language: asrSettings.language ?? 'auto',
    },
  };
}

export function isAgentConfigured(config) {
  return Boolean(
    config?.agent?.enabled
    && config.agent.model?.id?.trim()
    && config.agent.apiKey?.trim()
    && config.agent.baseUrl?.trim(),
  );
}

export function isAsrConfigured(config) {
  if (!config?.asr?.enabled) return false;
  if (config.asr.provider === 'apple-speech') return true;
  return Boolean(
    config.asr.provider === 'qwen-native-direct'
    && config.asr.apiKey?.trim()
    && config.asr.model?.trim(),
  );
}

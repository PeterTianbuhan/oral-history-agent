export const AGENT_PROVIDER_PRESETS = Object.freeze({
  openrouter: {
    id: 'openrouter',
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'openrouter/auto',
    modelName: 'OpenRouter Auto',
    provider: 'openrouter',
    contextWindow: 200000,
    maxTokens: 8192,
    reasoning: true,
    headers: {
      'HTTP-Referer': 'https://github.com/PeterTianbuhan/oral-history-agent',
      'X-OpenRouter-Title': 'My Life',
    },
  },
  openai: {
    id: 'openai',
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-5-mini',
    modelName: 'GPT-5 mini',
    provider: 'openai',
    contextWindow: 200000,
    maxTokens: 8192,
    reasoning: true,
  },
  aliyun: {
    id: 'aliyun',
    label: 'Alibaba Cloud Model Studio',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'deepseek-v4-flash-0731',
    modelName: 'DeepSeek V4 Flash 0731',
    provider: 'aliyun-bailian',
    contextWindow: 1000000,
    maxTokens: 32768,
    reasoning: true,
    compat: {
      thinkingFormat: 'qwen',
      supportsDeveloperRole: false,
      supportsStore: false,
      supportsReasoningEffort: true,
    },
  },
  custom: {
    id: 'custom',
    label: 'OpenAI-compatible',
    baseUrl: '',
    model: '',
    modelName: '',
    provider: 'openai-compatible',
    contextWindow: 131072,
    maxTokens: 8192,
    reasoning: true,
  },
});

export function agentProviderPreset(id) {
  return AGENT_PROVIDER_PRESETS[id] ?? AGENT_PROVIDER_PRESETS.openrouter;
}

export function settingsForAgentProvider(id) {
  const preset = agentProviderPreset(id);
  return {
    provider: preset.id,
    apiKey: '',
    baseUrl: preset.baseUrl,
    model: preset.model,
  };
}

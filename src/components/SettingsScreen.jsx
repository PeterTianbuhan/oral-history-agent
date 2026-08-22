import { useMemo, useState } from 'react';
import { settingsForAgentProvider } from '../config/provider-presets.js';
import { uiCopy } from '../i18n.js';

const PROVIDERS = [
  { id: 'openrouter', label: 'OpenRouter' },
  { id: 'openai', label: 'OpenAI' },
  { id: 'aliyun', label: 'Alibaba Cloud Model Studio' },
  { id: 'custom', label: 'OpenAI-compatible' },
];

function speechOptions(platform, copy) {
  if (platform === 'ios') {
    return [
      { id: 'apple-speech', label: copy.appleSpeech },
      { id: 'none', label: copy.speechOff },
    ];
  }
  if (platform === 'android') {
    return [
      { id: 'qwen-native-direct', label: copy.qwenSpeech },
      { id: 'none', label: copy.speechOff },
    ];
  }
  return [{ id: 'none', label: copy.speechOff }];
}

function EyeIcon({ hidden }) {
  return hidden ? (
    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 3l18 18M10.6 10.7a2 2 0 0 0 2.7 2.7M9.9 4.3A10.8 10.8 0 0 1 12 4c5.2 0 8.5 5.4 8.5 5.4a15 15 0 0 1-2.4 2.9M6.2 6.2a14.4 14.4 0 0 0-2.7 3.2S6.8 14.8 12 14.8c.7 0 1.4-.1 2-.3" /></svg>
  ) : (
    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 12S6.8 6.6 12 6.6 20.5 12 20.5 12 17.2 17.4 12 17.4 3.5 12 3.5 12Z" /><circle cx="12" cy="12" r="2.6" /></svg>
  );
}

export default function SettingsScreen({ settings, platform, onboarding, onSave, onCancel }) {
  const [draft, setDraft] = useState(settings);
  const [showAgentKey, setShowAgentKey] = useState(false);
  const [showSpeechKey, setShowSpeechKey] = useState(false);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const copy = uiCopy(draft.locale).settings;
  const availableSpeech = useMemo(() => speechOptions(platform, copy), [platform, copy]);

  function updateAgent(fields) {
    setDraft((current) => ({ ...current, agent: { ...current.agent, ...fields } }));
  }

  function updateAsr(fields) {
    setDraft((current) => ({ ...current, asr: { ...current.asr, ...fields } }));
  }

  function changeProvider(provider) {
    setDraft((current) => ({
      ...current,
      agent: settingsForAgentProvider(provider),
    }));
    setError('');
  }

  function changeSpeech(provider) {
    updateAsr({
      provider,
      apiKey: provider === 'qwen-native-direct' ? draft.asr.apiKey : '',
      model: provider === 'qwen-native-direct'
        ? 'qwen3-asr-flash-realtime'
        : (provider === 'apple-speech' ? 'apple-speech' : ''),
    });
    setError('');
  }

  async function submit(event) {
    event.preventDefault();
    if (
      (onboarding || draft.agent.apiKey.trim())
      && (!draft.agent.apiKey.trim() || !draft.agent.model.trim() || !draft.agent.baseUrl.trim())
    ) {
      setError(copy.needAgent);
      return;
    }
    if (draft.asr.provider === 'qwen-native-direct' && !draft.asr.apiKey.trim()) {
      setError(copy.needSpeechKey);
      return;
    }
    setSaving(true);
    setError('');
    try {
      await onSave({ ...draft, onboardingComplete: true });
    } catch {
      setError(copy.saveFailed);
    } finally {
      setSaving(false);
    }
  }

  return (
    <main className="settings-shell" lang={draft.locale}>
      <header className="settings-header">
        {onboarding ? (
          <span className="settings-header__eyebrow">{copy.start}</span>
        ) : (
          <button className="settings-back" type="button" onClick={onCancel} aria-label={copy.cancel}>‹</button>
        )}
        {!onboarding && <span className="settings-header__title">{copy.pageTitle}</span>}
      </header>

      <form className="settings-form" onSubmit={submit}>
        {onboarding && (
          <div className="settings-intro">
            <h1>{copy.title}</h1>
            <p>{copy.subtitle}</p>
          </div>
        )}

        <section className="settings-section" aria-labelledby="agent-settings-heading">
          <h2 id="agent-settings-heading">{copy.agentSection}</h2>
          <label className="settings-field">
            <span>{copy.service}</span>
            <span className="settings-select-row">
              <select value={draft.agent.provider} onChange={(event) => changeProvider(event.target.value)}>
                {PROVIDERS.map((provider) => <option value={provider.id} key={provider.id}>{provider.label}</option>)}
              </select>
              {draft.agent.provider === 'openrouter' && <em>{copy.recommended}</em>}
            </span>
          </label>

          <label className="settings-field">
            <span>{copy.apiKey}</span>
            <span className="settings-secret">
              <input
                type={showAgentKey ? 'text' : 'password'}
                value={draft.agent.apiKey}
                placeholder={copy.apiKeyPlaceholder}
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck="false"
                onChange={(event) => updateAgent({ apiKey: event.target.value })}
              />
              <button type="button" onClick={() => setShowAgentKey((value) => !value)} aria-label={showAgentKey ? copy.hideKey : copy.showKey}>
                <EyeIcon hidden={!showAgentKey} />
              </button>
            </span>
          </label>
          {draft.agent.provider === 'openrouter' && (
            <a className="settings-link" href="https://openrouter.ai/settings/keys" target="_blank" rel="noreferrer">{copy.openrouterLink} ↗</a>
          )}

          <label className="settings-field">
            <span>{copy.model}</span>
            <input
              type="text"
              value={draft.agent.model}
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck="false"
              onChange={(event) => updateAgent({ model: event.target.value })}
            />
            <small>{copy.modelHint}</small>
          </label>

          {draft.agent.provider === 'custom' && (
            <label className="settings-field">
              <span>{copy.endpoint}</span>
              <input
                type="url"
                value={draft.agent.baseUrl}
                placeholder="https://example.com/v1"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck="false"
                onChange={(event) => updateAgent({ baseUrl: event.target.value })}
              />
            </label>
          )}
        </section>

        <section className="settings-section" aria-labelledby="speech-settings-heading">
          <h2 id="speech-settings-heading">{copy.speechSection}</h2>
          <label className="settings-field">
            <span>{copy.speech}</span>
            <select value={draft.asr.provider} onChange={(event) => changeSpeech(event.target.value)}>
              {availableSpeech.map((option) => <option value={option.id} key={option.id}>{option.label}</option>)}
            </select>
          </label>

          {draft.asr.provider === 'qwen-native-direct' && (
            <label className="settings-field">
              <span>{copy.speechKey}</span>
              <span className="settings-secret">
                <input
                  type={showSpeechKey ? 'text' : 'password'}
                  value={draft.asr.apiKey}
                  placeholder={copy.apiKeyPlaceholder}
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck="false"
                  onChange={(event) => updateAsr({ apiKey: event.target.value })}
                />
                <button type="button" onClick={() => setShowSpeechKey((value) => !value)} aria-label={showSpeechKey ? copy.hideKey : copy.showKey}>
                  <EyeIcon hidden={!showSpeechKey} />
                </button>
              </span>
              <small>{copy.speechKeyHint}</small>
            </label>
          )}
        </section>

        <section className="settings-section" aria-labelledby="language-settings-heading">
          <h2 id="language-settings-heading">{copy.languageSection}</h2>
          <label className="settings-field">
            <span>{copy.language}</span>
            <select value={draft.locale} onChange={(event) => setDraft((current) => ({ ...current, locale: event.target.value }))}>
              {Object.entries(copy.languageNames).map(([value, label]) => <option value={value} key={value}>{label}</option>)}
            </select>
          </label>
        </section>

        <p className="settings-privacy">{copy.localOnly}</p>
        {error && <p className="settings-error" role="alert">{error}</p>}

        <button className="settings-submit" type="submit" disabled={saving}>
          {onboarding ? copy.saveStart : copy.save}
        </button>
        {!onboarding && (
          <button
            className="settings-clear"
            type="button"
            onClick={() => setDraft((current) => ({
              ...current,
              agent: { ...current.agent, apiKey: '' },
              asr: { ...current.asr, provider: 'none', apiKey: '', model: '' },
            }))}
          >
            {copy.clearKeys}
          </button>
        )}
      </form>
    </main>
  );
}

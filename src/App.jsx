import { useEffect, useRef, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import {
  exportFullBackup,
  exportSectionMarkdown,
  loadMemoryState,
  persistMemoryState,
} from './platform/memory-store.js';
import {
  cancelDeviceRecording,
  cutDeviceRecording,
  hasNativeRecorder,
  startDeviceRecording,
  stopDeviceRecording,
} from './platform/native-recorder.js';
import './asr/qwen-realtime-provider.js';
import {
  isAgentConfigured,
  isAsrConfigured,
  runtimeConfigFromSettings,
} from './config/runtime-config.js';
import { loadAppSettings, persistAppSettings } from './config/app-settings.js';
import { createAgentJob, enqueueAgentJob } from './agent/job-queue.js';
import { processAgentQueue } from './agent/agent-service.js';
import { mergeAgentCheckpoint } from './agent/checkpoint-merge.js';
import { updateStreamingReplies } from './agent/streaming-replies.js';
import {
  appendConversationMessage as appendConversationRecord,
  emptyConversation,
} from './agent/conversation-context.js';
import { startAsrSession } from './asr/asr-runtime.js';
import { resolveSegmentTranscript } from './asr/transcript.js';
import SettingsScreen from './components/SettingsScreen.jsx';
import { uiCopy } from './i18n.js';

const DEFAULT_MEMORY = {
  version: 2,
  profile: {
    id: 'self',
    title: 'My Life',
  },
  timeline: [],
  peopleEntries: [],
  placeEntries: [],
  facts: [],
  evidence: [],
  conversation: emptyConversation(),
  agentJobs: [],
  updatedAt: null,
};

function asrTranscript(value) {
  if (typeof value === 'string') return value.trim();
  if (value && typeof value.text === 'string') return value.text.trim();
  return '';
}

function Icon({ name, size = 26, strokeWidth = 1.8 }) {
  const common = {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    'aria-hidden': true,
  };

  if (name === 'mic') {
    return (
      <svg {...common}>
        <rect x="9" y="2.5" width="6" height="12" rx="3" />
        <path d="M5.8 11.5a6.2 6.2 0 0 0 12.4 0" />
        <path d="M12 17.7v3.8M8.7 21.5h6.6" />
      </svg>
    );
  }

  if (name === 'send') {
    return (
      <svg {...common}>
        <path d="m4 5 16 7-16 7 3.4-7Z" />
        <path d="M7.4 12H20" />
      </svg>
    );
  }

  if (name === 'backup') {
    return (
      <svg {...common}>
        <path d="M12 3v11" />
        <path d="m7.8 10.2 4.2 4.2 4.2-4.2" />
        <path d="M5 16.5v3h14v-3" />
      </svg>
    );
  }

  if (name === 'settings') {
    return (
      <svg {...common}>
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1A1.7 1.7 0 0 0 9 4.6 1.7 1.7 0 0 0 10 3V2.8h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1Z" />
      </svg>
    );
  }

  if (name === 'life') {
    return (
      <svg {...common}>
        <path d="M4.5 5.2c2.6-.8 5-.3 7.5 1.2v13c-2.5-1.5-4.9-2-7.5-1.2z" />
        <path d="M19.5 5.2c-2.6-.8-5-.3-7.5 1.2v13c2.5-1.5 4.9-2 7.5-1.2z" />
      </svg>
    );
  }

  if (name === 'people') {
    return (
      <svg {...common}>
        <circle cx="9" cy="8" r="3" />
        <path d="M3.8 18.5c.6-3.1 2.3-4.7 5.2-4.7s4.6 1.6 5.2 4.7" />
        <path d="M14.2 5.7a3 3 0 0 1 0 5.7M15.8 14.1c2.4.3 3.8 1.8 4.4 4.4" />
      </svg>
    );
  }

  if (name === 'place') {
    return (
      <svg {...common}>
        <path d="M19 10.2c0 5-7 11.3-7 11.3S5 15.2 5 10.2a7 7 0 1 1 14 0Z" />
        <circle cx="12" cy="10" r="2.4" />
      </svg>
    );
  }

  return null;
}

function EditableCopy({
  as: Tag,
  value,
  onCommit,
  onEditingChange,
  label,
  singleLine = false,
}) {
  const element = useRef(null);

  useEffect(() => {
    if (element.current && document.activeElement !== element.current) {
      element.current.textContent = value ?? '';
    }
  }, [value]);

  function commit() {
    const next = String(element.current?.textContent ?? '')
      .replace(singleLine ? /\s+/g : /\n{3,}/g, singleLine ? ' ' : '\n\n')
      .trim();
    if (!next) {
      if (element.current) element.current.textContent = value ?? '';
      return;
    }
    if (next !== value) onCommit(next);
  }

  return (
    <Tag
      ref={element}
      className="editable-copy"
      contentEditable
      suppressContentEditableWarning
      role="textbox"
      aria-label={label}
      aria-multiline={!singleLine}
      spellCheck="false"
      onFocus={() => onEditingChange?.(true)}
      onBlur={() => {
        commit();
        window.setTimeout(() => {
          if (!document.activeElement?.classList?.contains('editable-copy')) {
            onEditingChange?.(false);
          }
        }, 0);
      }}
      onKeyDown={(event) => {
        if (singleLine && event.key === 'Enter') {
          event.preventDefault();
          event.currentTarget.blur();
        } else if (event.key === 'Escape') {
          event.currentTarget.textContent = value ?? '';
          event.currentTarget.blur();
        }
      }}
    />
  );
}

function StoryBlock({ entry, onUpdate, onEditingChange, copy }) {
  return (
    <article
      className={`story-block ${entry.fresh ? 'story-block--fresh' : ''}`}
      data-story-id={entry.id}
    >
      <span className="story-block__dot" aria-hidden="true" />
      <div className="story-block__topline">
        <EditableCopy
          as="h2"
          value={entry.time}
          onCommit={(time) => onUpdate(entry.id, { time })}
          onEditingChange={onEditingChange}
          label={copy.edit.storyTime}
          singleLine
        />
      </div>
      <EditableCopy
        as="p"
        value={entry.text}
        onCommit={(text) => onUpdate(entry.id, { text })}
        onEditingChange={onEditingChange}
        label={copy.edit.story}
      />
    </article>
  );
}

function StoryTimeline({
  entries,
  onUpdate,
  onEditingChange,
  copy,
  compact = false,
  ariaLabel,
}) {
  const visibleEntries = compact ? entries.slice(Math.max(entries.length - 3, 0)) : entries;

  return (
    <section className={`timeline ${compact ? 'timeline--compact' : ''}`} aria-label={ariaLabel ?? copy.edit.timeline}>
      {visibleEntries.length > 0 && <div className="timeline__rail" aria-hidden="true" />}
      {visibleEntries.map((entry) => (
        <StoryBlock
          entry={entry}
          onUpdate={onUpdate}
          onEditingChange={onEditingChange}
          copy={copy}
          key={entry.id}
        />
      ))}
    </section>
  );
}

function QuietEmptyState({ type, copy }) {
  const content = type === 'people'
    ? {
        eyebrow: copy.empty.peopleEyebrow,
        copy: copy.empty.peopleCopy,
      }
    : {
        eyebrow: copy.empty.placesEyebrow,
        copy: copy.empty.placesCopy,
      };

  return (
    <section className="quiet-empty" aria-label={content.eyebrow}>
      <span className="quiet-empty__icon" aria-hidden="true">
        <Icon name={type === 'people' ? 'people' : 'place'} size={27} />
      </span>
      <p className="quiet-empty__eyebrow">{content.eyebrow}</p>
      <p className="quiet-empty__copy">{content.copy}</p>
    </section>
  );
}

function IndexCards({ entries, type, onUpdate, onEditingChange, copy }) {
  const [openId, setOpenId] = useState(null);
  const isPeople = type === 'people';

  return (
    <section className="index-cards" aria-label={isPeople ? copy.edit.peopleCards : copy.edit.placeCards}>
      {entries.map((entry) => {
        const isOpen = openId === entry.id;

        return (
          <article className={`index-card ${isOpen ? 'index-card--open' : ''}`} key={entry.id}>
            <button
              className="index-card__button"
              type="button"
              aria-expanded={isOpen}
              onClick={() => setOpenId(isOpen ? null : entry.id)}
            >
              <span className="index-card__icon" aria-hidden="true">
                <Icon name={isPeople ? 'people' : 'place'} size={24} />
              </span>
              <span className="index-card__body">
                <span className="index-card__title-row">
                  <span className="index-card__title">{entry.time}</span>
                </span>
                <span className="index-card__count">{copy.storyCount(entry.count ?? 1)}</span>
              </span>
              <span className="index-card__chevron" aria-hidden="true">›</span>
            </button>

            {isOpen && (
              <div className="index-card__detail">
                <EditableCopy
                  as="blockquote"
                  value={entry.text}
                  onCommit={(text) => onUpdate(entry.id, { text })}
                  onEditingChange={onEditingChange}
                  label={isPeople ? copy.edit.people : copy.edit.place}
                />
              </div>
            )}
          </article>
        );
      })}
    </section>
  );
}

function ConversationScreen({
  transcript,
  messages,
  streamingMessages,
  onSend,
  onVoiceStart,
  onVoiceEnd,
  onTranscriptChange,
  listening,
  busy,
  ready,
  voiceAvailable,
  copy,
}) {
  const messageLog = useRef(null);

  useEffect(() => {
    const log = messageLog.current;
    if (log) log.scrollTop = log.scrollHeight;
  }, [messages, streamingMessages]);

  return (
    <section className="conversation-screen" aria-label={copy.conversation.label}>
      <div
        className="conversation-log"
        ref={messageLog}
        role="log"
        aria-live="polite"
        aria-relevant="additions"
        aria-busy={streamingMessages.length > 0}
      >
        {messages.map((message) => (
          <p
            className={`conversation-turn conversation-turn--${message.role}`}
            aria-label={message.role === 'agent' ? copy.conversation.agent : copy.conversation.narrator}
            key={message.id}
          >
            {message.text}
          </p>
        ))}
        {streamingMessages.map((message) => (
          <p
            className="conversation-turn conversation-turn--agent conversation-turn--streaming"
            data-streaming-reply="true"
            aria-label={copy.conversation.streaming}
            key={message.id}
          >
            {message.text}
          </p>
        ))}
      </div>

      <div className="conversation-composer">
        <label className="composer-field">
          <span className="visually-hidden">{copy.conversation.transcript}</span>
          <textarea
            aria-label={copy.conversation.transcript}
            value={transcript}
            onChange={(event) => onTranscriptChange(event.target.value)}
            placeholder={listening ? copy.conversation.continue : copy.conversation.saySomething}
            spellCheck="false"
          />
        </label>
        <div className="composer-actions">
          {listening ? (
            <button
              className="recording-stop-button"
              type="button"
              onClick={onVoiceEnd}
              disabled={busy}
            >
              {copy.conversation.stop}
            </button>
          ) : (
            <button
              className="composer-mic-button"
              type="button"
              onClick={onVoiceStart}
              disabled={!ready || busy || Boolean(transcript.trim()) || !voiceAvailable}
              aria-label={copy.conversation.start}
            >
              <Icon name="mic" size={25} strokeWidth={2} />
            </button>
          )}
          <span className="composer-spacer" />
        <button
          className="send-button"
          type="button"
          onClick={onSend}
          disabled={(!transcript.trim() && !(listening && hasNativeRecorder)) || busy || !ready}
        >
          {copy.conversation.send}
          <Icon name="send" size={19} strokeWidth={2} />
        </button>
        </div>
      </div>
    </section>
  );
}

function BottomNavigation({ active, onChange, disabled, copy }) {
  const items = [
    { id: 'chat', label: copy.nav.chat, icon: 'mic' },
    { id: 'life', label: copy.nav.life, icon: 'life' },
    { id: 'people', label: copy.nav.people, icon: 'people' },
    { id: 'places', label: copy.nav.places, icon: 'place' },
  ];

  return (
    <nav className="bottom-nav" aria-label={copy.nav.label}>
      {items.map((item) => (
        <button
          className={active === item.id ? 'is-active' : ''}
          type="button"
          key={item.id}
          onClick={() => onChange(item.id)}
          disabled={disabled}
          aria-current={active === item.id ? 'page' : undefined}
        >
          <Icon name={item.icon} size={27} />
          <span>{item.label}</span>
        </button>
      ))}
    </nav>
  );
}

export default function App() {
  const [activeSection, setActiveSection] = useState('chat');
  const [memory, setMemory] = useState(DEFAULT_MEMORY);
  const [appSettings, setAppSettings] = useState(null);
  const [runtimeConfig, setRuntimeConfig] = useState(null);
  const [showSettings, setShowSettings] = useState(false);
  const [phase, setPhase] = useState('idle');
  const [transcript, setTranscript] = useState('');
  const [hydrated, setHydrated] = useState(false);
  const [isStarting, setIsStarting] = useState(false);
  const [isSegmenting, setIsSegmenting] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [isContentEditing, setIsContentEditing] = useState(false);
  const [streamingAgentMessages, setStreamingAgentMessages] = useState([]);
  const [agentWake, setAgentWake] = useState(0);
  const segmentSequence = useRef(0);
  const conversationSequence = useRef(0);
  const memoryRef = useRef(DEFAULT_MEMORY);
  const agentProcessing = useRef(false);
  const asrSession = useRef(null);
  const pendingVoiceDraft = useRef(null);
  const transcriptRef = useRef('');
  const transcriptEdited = useRef(false);
  const pauseAsrDisplay = useRef(false);
  const editingLock = useRef({ active: false, waiters: [] });

  const copy = uiCopy(appSettings?.locale ?? 'zh-CN');
  const section = copy.sections[activeSection];
  const platform = Capacitor.getPlatform();
  const isListening = phase === 'listening';
  const {
    timeline,
    peopleEntries,
    placeEntries,
  } = memory;

  function updateMemory(updater) {
    const current = memoryRef.current;
    const next = typeof updater === 'function' ? updater(current) : updater;
    memoryRef.current = next;
    setMemory(next);
  }

  function appendConversationMessage(role, value, { segmentId = null } = {}) {
    const text = String(value ?? '').trim();
    if (!text) return;
    conversationSequence.current += 1;
    const timestamp = new Date().toISOString();
    updateMemory((current) => ({
      ...current,
      conversation: appendConversationRecord(current.conversation, {
        id: `${role}-${segmentId ?? 'message'}-${Date.now()}-${conversationSequence.current}`,
        role,
        text,
        segmentId,
        createdAt: timestamp,
      }),
    }));
  }

  function updateStreamingAgentMessage(value, metadata = {}) {
    setStreamingAgentMessages((current) => updateStreamingReplies(current, value, metadata));
  }

  function receiveAgentMessage(message, metadata = {}) {
    if (metadata.toolCallId) {
      updateStreamingAgentMessage('', { ...metadata, done: true });
    }
    appendConversationMessage('agent', message, {
      segmentId: metadata.segmentId ?? null,
    });
  }

  function setContentEditing(active) {
    editingLock.current.active = active;
    setIsContentEditing(active);
    if (!active) {
      const waiters = editingLock.current.waiters.splice(0);
      waiters.forEach((resolve) => resolve());
    }
  }

  function waitForContentEdit() {
    if (!editingLock.current.active) return Promise.resolve(memoryRef.current);
    return new Promise((resolve) => editingLock.current.waiters.push(() => {
      resolve(memoryRef.current);
    }));
  }

  useEffect(() => {
    let active = true;

    Promise.all([
      loadMemoryState(DEFAULT_MEMORY),
      loadAppSettings({ platform }),
    ]).then(([loadedMemory, loadedSettings]) => {
      if (!active) return;
      memoryRef.current = loadedMemory;
      setMemory(loadedMemory);
      setAppSettings(loadedSettings);
      setRuntimeConfig(runtimeConfigFromSettings(loadedSettings));
      setHydrated(true);
    });

    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    transcriptRef.current = transcript;
  }, [transcript]);

  useEffect(() => {
    if (!hydrated) return undefined;

    const saveTimer = window.setTimeout(() => {
      persistMemoryState(memory)
        .catch((error) => console.error('Unable to save local memory', error));
    }, 180);

    return () => window.clearTimeout(saveTimer);
  }, [hydrated, memory]);

  useEffect(() => {
    if (
      !hydrated
      || !isAgentConfigured(runtimeConfig)
      || isContentEditing
      || agentProcessing.current
      || !memory.agentJobs.some((job) => job.status === 'pending')
    ) return;

    agentProcessing.current = true;
    let agentBase = memoryRef.current;
    processAgentQueue({
      memory: memoryRef.current,
      config: runtimeConfig,
      maxJobs: 1,
      beforeAgentAction: waitForContentEdit,
      onCheckpoint: async (checkpoint) => {
        await waitForContentEdit();
        const merged = mergeAgentCheckpoint(memoryRef.current, checkpoint, agentBase);
        agentBase = checkpoint;
        memoryRef.current = merged;
        setMemory(merged);
        await persistMemoryState(merged);
      },
      onSpeak: receiveAgentMessage,
      onSpeakPartial: updateStreamingAgentMessage,
    }).catch((error) => {
      console.error('Unable to process memory agent queue', error);
    }).finally(() => {
      agentProcessing.current = false;
      setAgentWake((current) => current + 1);
    });
  }, [agentWake, hydrated, isContentEditing, memory.agentJobs, runtimeConfig]);

  useEffect(() => () => {
    void asrSession.current?.abort();
    editingLock.current.active = false;
    editingLock.current.waiters.splice(0).forEach((resolve) => resolve());
  }, []);

  async function beginStory() {
    if (isStarting || transcriptRef.current.trim()) return;
    if (!hasNativeRecorder) {
      window.alert(copy.alerts.phoneOnly);
      return;
    }
    pendingVoiceDraft.current = null;
    setIsStarting(true);
    transcriptEdited.current = false;
    pauseAsrDisplay.current = false;
    transcriptRef.current = '';

    try {
      if (isAsrConfigured(runtimeConfig)) try {
        asrSession.current = await startAsrSession({
          config: runtimeConfig?.asr,
          onPartial: (value) => {
            const nextTranscript = asrTranscript(value);
            if (nextTranscript && !pauseAsrDisplay.current && !transcriptEdited.current) {
              setTranscript(nextTranscript);
            }
          },
          onFinal: (value) => {
            const nextTranscript = asrTranscript(value);
            if (nextTranscript && !pauseAsrDisplay.current && !transcriptEdited.current) {
              setTranscript(nextTranscript);
            }
          },
          onError: (error) => console.error('ASR session failed', error),
        });
      } catch (error) {
        asrSession.current = null;
        console.error('Unable to start ASR session', error);
      }
      await startDeviceRecording();
      window.scrollTo({ top: 0 });
      setPhase('listening');
      setTranscript('');
    } catch (error) {
      void asrSession.current?.abort();
      asrSession.current = null;
      void cancelDeviceRecording().catch(() => {});
      if (error instanceof Error && error.message === 'microphone-permission-denied') {
        window.alert(copy.alerts.microphone);
      } else {
        window.alert(copy.alerts.recordingStart);
      }
    } finally {
      setIsStarting(false);
    }
  }

  function editTranscript(nextTranscript) {
    transcriptEdited.current = true;
    transcriptRef.current = nextTranscript;
    setTranscript(nextTranscript);
  }

  function updateFormedContent(collectionName, id, fields) {
    updateMemory((current) => ({
      ...current,
      [collectionName]: current[collectionName].map((entry) => entry.id === id
        ? {
            ...entry,
            ...fields,
            fresh: false,
            updatedAt: new Date().toISOString(),
          }
        : entry),
    }));
  }

  async function captureEvidence({
    rawText,
    segmentId,
    recording,
    queueForAgent,
    source = hasNativeRecorder ? `${platform}-audio-recorder` : 'typed',
  }) {
    const evidenceEntry = {
      id: `evidence-${segmentId}`,
      segmentId,
      capturedAt: new Date().toISOString(),
      rawText,
      correctedText: rawText,
      audioUri: recording?.audioUri ?? null,
      durationMs: recording?.durationMs ?? null,
      audioStorage: recording?.storage ?? null,
      source,
      transcriptionStatus: rawText ? 'available' : 'pending',
    };
    updateMemory((current) => {
      const nextEvidence = [...current.evidence, evidenceEntry];
      if (!rawText || !queueForAgent) {
        return { ...current, evidence: nextEvidence };
      }
      const job = createAgentJob({
        segmentId,
        evidenceId: evidenceEntry.id,
        transcript: rawText,
        section: activeSection,
        locale: appSettings?.locale ?? 'zh-CN',
      });
      return {
        ...current,
        evidence: nextEvidence,
        agentJobs: enqueueAgentJob(current.agentJobs, job),
      };
    });
    return evidenceEntry;
  }

  async function sendCurrentSegment() {
    if (!isListening || isSegmenting) return false;
    segmentSequence.current += 1;
    const segmentId = `memory-${Date.now()}-${segmentSequence.current}`;
    const visibleText = transcriptRef.current.trim();
    const userCorrected = transcriptEdited.current;

    pauseAsrDisplay.current = true;
    transcriptEdited.current = false;
    transcriptRef.current = '';
    setTranscript('');
    setIsSegmenting(true);

    try {
      const [recording, finalized] = await Promise.all([
        hasNativeRecorder
          ? cutDeviceRecording(segmentId).catch((error) => {
              console.error('Unable to cut recording evidence', error);
              window.alert(copy.alerts.recordingSave);
              return null;
            })
          : Promise.resolve(null),
        asrSession.current?.cutSegment().catch((error) => {
          console.error('Unable to finalize current ASR segment', error);
          return '';
        }) ?? Promise.resolve(''),
      ]);
      if (recording?.persistenceError) {
        window.alert(copy.alerts.recordingSave);
      }
      const asrFinal = asrTranscript(finalized);
      const rawText = resolveSegmentTranscript({
        visibleText,
        finalizedText: asrFinal,
        userCorrected,
      });
      if (!rawText && !hasNativeRecorder) return false;

      if (rawText) appendConversationMessage('narrator', rawText, { segmentId });
      else if (recording) {
        appendConversationMessage(
          'agent',
          copy.alerts.audioOnly,
          { segmentId },
        );
      }

      const agentReady = isAgentConfigured(runtimeConfig);
      await captureEvidence({
        rawText,
        segmentId,
        recording,
        queueForAgent: agentReady,
      });
    } finally {
      pauseAsrDisplay.current = false;
      setIsSegmenting(false);
    }
    return true;
  }

  async function sendTypedTurn() {
    if (isListening) return sendCurrentSegment();
    if (isSegmenting) return false;
    const rawText = transcriptRef.current.trim();
    if (!rawText) return false;

    const pendingVoice = pendingVoiceDraft.current;
    let segmentId = pendingVoice?.segmentId;
    if (!segmentId) {
      segmentSequence.current += 1;
      segmentId = `memory-${Date.now()}-${segmentSequence.current}`;
    }
    pendingVoiceDraft.current = null;
    transcriptEdited.current = false;
    transcriptRef.current = '';
    setTranscript('');
    setIsSegmenting(true);
    try {
      appendConversationMessage('narrator', rawText, { segmentId });
      const agentReady = isAgentConfigured(runtimeConfig);
      await captureEvidence({
        rawText,
        segmentId,
        recording: pendingVoice?.recording ?? null,
        queueForAgent: agentReady,
        source: pendingVoice?.source ?? 'typed',
      });
    } finally {
      setIsSegmenting(false);
    }
    return true;
  }

  async function endStory() {
    if (!isListening || isSegmenting) return;
    segmentSequence.current += 1;
    const segmentId = `memory-${Date.now()}-${segmentSequence.current}`;
    const visibleText = transcriptRef.current.trim();
    const userCorrected = transcriptEdited.current;

    pauseAsrDisplay.current = true;
    setIsSegmenting(true);
    try {
      let recording = null;
      if (hasNativeRecorder) {
        try {
          recording = await stopDeviceRecording(segmentId);
          if (recording.persistenceError) {
            window.alert(copy.alerts.recordingSave);
          }
        } catch (error) {
          console.error('Unable to stop recording evidence', error);
          window.alert(copy.alerts.recordingSave);
        }
      }

      let asrFinal = '';
      try {
        asrFinal = asrTranscript(await asrSession.current?.stop());
      } catch (error) {
        console.error('Unable to stop ASR session', error);
      }
      asrSession.current = null;
      const rawText = resolveSegmentTranscript({
        visibleText,
        finalizedText: asrFinal,
        userCorrected,
      });
      pendingVoiceDraft.current = {
        segmentId,
        recording,
        source: hasNativeRecorder ? `${platform}-audio-recorder` : 'voice-transcript',
      };
      transcriptEdited.current = false;
      transcriptRef.current = rawText;
      setTranscript(rawText);
      setPhase('idle');
    } finally {
      pauseAsrDisplay.current = false;
      setIsSegmenting(false);
    }
  }

  function changeSection(nextSection) {
    if (isListening) return;
    setActiveSection(nextSection);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  async function exportCurrentMemory() {
    if (isExporting) return;
    setIsExporting(true);
    try {
      if (activeSection === 'chat') {
        await exportFullBackup(memoryRef.current, appSettings.locale);
      } else {
        await exportSectionMarkdown(memoryRef.current, activeSection, appSettings.locale);
      }
    } catch {
      window.alert(copy.alerts.export);
    } finally {
      setIsExporting(false);
    }
  }

  async function saveSettings(nextSettings) {
    const saved = await persistAppSettings(nextSettings);
    setAppSettings(saved);
    setRuntimeConfig(runtimeConfigFromSettings(saved));
    setShowSettings(false);
    setAgentWake((current) => current + 1);
  }

  if (!hydrated || !appSettings) {
    return <div className="app-loading" aria-busy="true" />;
  }

  if (!appSettings.onboardingComplete || showSettings) {
    return (
      <SettingsScreen
        settings={appSettings}
        platform={platform}
        onboarding={!appSettings.onboardingComplete}
        onSave={saveSettings}
        onCancel={() => setShowSettings(false)}
      />
    );
  }

  const storySurface = (
    <>
      {activeSection === 'life' && (
        <StoryTimeline
          entries={timeline}
          compact={isListening}
          onUpdate={(id, fields) => updateFormedContent('timeline', id, fields)}
          onEditingChange={setContentEditing}
          copy={copy}
        />
      )}
      {activeSection === 'people' && (
        peopleEntries.length > 0
          ? (
              <IndexCards
                entries={peopleEntries}
                type="people"
                onUpdate={(id, fields) => updateFormedContent('peopleEntries', id, fields)}
                onEditingChange={setContentEditing}
                copy={copy}
              />
            )
          : <QuietEmptyState type="people" copy={copy} />
      )}
      {activeSection === 'places' && (
        placeEntries.length > 0
          ? (
              <IndexCards
                entries={placeEntries}
                type="places"
                onUpdate={(id, fields) => updateFormedContent('placeEntries', id, fields)}
                onEditingChange={setContentEditing}
                copy={copy}
              />
            )
          : <QuietEmptyState type="places" copy={copy} />
      )}
    </>
  );

  return (
    <div className={`app-shell ${activeSection === 'chat' ? 'app-shell--chat' : ''}`}>
      <header className={`page-header ${activeSection === 'chat' ? '' : 'page-header--actions-only'}`}>
        <h1 className="visually-hidden">{section.title}</h1>
        {activeSection === 'chat' && <p>{section.subtitle}</p>}
        <button
          className="settings-button"
          type="button"
          onClick={() => setShowSettings(true)}
          disabled={isListening || isStarting}
          aria-label={copy.actions.settings}
          title={copy.actions.settings}
        >
          <Icon name="settings" size={22} strokeWidth={1.65} />
        </button>
        <button
          className="backup-button"
          type="button"
          onClick={exportCurrentMemory}
          disabled={!hydrated || isExporting}
          aria-label={activeSection === 'chat' ? copy.actions.fullBackupLabel : copy.actions.markdownLabel}
          title={activeSection === 'chat' ? copy.actions.fullBackup : copy.actions.markdown}
        >
          <Icon name="backup" size={23} strokeWidth={1.8} />
        </button>
      </header>

      <main className={activeSection === 'chat' ? 'main-content main-content--chat' : 'main-content'}>
        {activeSection === 'chat' ? (
          <ConversationScreen
            transcript={transcript}
            messages={memory.conversation?.messages ?? []}
            streamingMessages={streamingAgentMessages}
            onSend={sendTypedTurn}
            onVoiceStart={beginStory}
            onVoiceEnd={endStory}
            onTranscriptChange={editTranscript}
            listening={isListening}
            busy={isSegmenting || isStarting}
            ready={hydrated}
            voiceAvailable={hasNativeRecorder}
            copy={copy}
          />
        ) : storySurface}
      </main>

      <BottomNavigation
        active={activeSection}
        onChange={changeSection}
        disabled={isListening || isStarting}
        copy={copy}
      />
    </div>
  );
}

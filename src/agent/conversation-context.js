export const CONVERSATION_COMPACT_THRESHOLD = 24;
export const CONVERSATION_KEEP_RECENT = 10;

function stringOrNull(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function emptyConversation() {
  return {
    version: 1,
    messages: [],
    compact: {
      summary: '',
      throughMessageId: null,
      updatedAt: null,
    },
  };
}

export function normalizeConversation(value) {
  const fallback = emptyConversation();
  if (!value || typeof value !== 'object') return fallback;

  const seen = new Set();
  const messages = (Array.isArray(value.messages) ? value.messages : [])
    .filter((message) => {
      if (!message || typeof message.id !== 'string' || seen.has(message.id)) return false;
      if (message.role !== 'narrator' && message.role !== 'agent') return false;
      if (typeof message.text !== 'string' || !message.text.trim()) return false;
      seen.add(message.id);
      return true;
    })
    .map((message) => ({
      id: message.id,
      role: message.role,
      text: message.text.trim(),
      segmentId: stringOrNull(message.segmentId),
      createdAt: stringOrNull(message.createdAt),
    }));

  return {
    version: 1,
    messages,
    compact: {
      summary: typeof value.compact?.summary === 'string' ? value.compact.summary.trim() : '',
      throughMessageId: stringOrNull(value.compact?.throughMessageId),
      updatedAt: stringOrNull(value.compact?.updatedAt),
    },
  };
}

export function appendConversationMessage(conversation, message) {
  const current = normalizeConversation(conversation);
  const text = String(message?.text ?? '').trim();
  if (!message?.id || !text || !['narrator', 'agent'].includes(message.role)) return current;
  if (current.messages.some((candidate) => candidate.id === message.id)) return current;

  return {
    ...current,
    messages: [
      ...current.messages,
      {
        id: message.id,
        role: message.role,
        text,
        segmentId: stringOrNull(message.segmentId),
        createdAt: stringOrNull(message.createdAt),
      },
    ],
  };
}

function firstUncompactedIndex(conversation) {
  const throughId = conversation.compact.throughMessageId;
  if (!throughId) return 0;
  const index = conversation.messages.findIndex((message) => message.id === throughId);
  return index < 0 ? 0 : index + 1;
}

export function planConversationCompaction(conversation, {
  threshold = CONVERSATION_COMPACT_THRESHOLD,
  keepRecent = CONVERSATION_KEEP_RECENT,
  stopBeforeSegmentIds = [],
} = {}) {
  const current = normalizeConversation(conversation);
  const blockedSegments = new Set(stopBeforeSegmentIds.filter(Boolean));
  let pending = current.messages.slice(firstUncompactedIndex(current));
  const stopIndex = pending.findIndex((message) => (
    message.segmentId && blockedSegments.has(message.segmentId)
  ));
  if (stopIndex >= 0) pending = pending.slice(0, stopIndex);
  if (pending.length <= threshold) return null;

  const batch = pending.slice(0, Math.max(0, pending.length - keepRecent));
  if (batch.length === 0) return null;

  return {
    previousSummary: current.compact.summary,
    messages: batch,
    throughMessageId: batch.at(-1).id,
  };
}

export function applyConversationCompaction(conversation, plan, summary, updatedAt) {
  const current = normalizeConversation(conversation);
  const nextSummary = String(summary ?? '').trim();
  if (!plan?.throughMessageId || !nextSummary) return current;

  return {
    ...current,
    compact: {
      summary: nextSummary,
      throughMessageId: plan.throughMessageId,
      updatedAt: stringOrNull(updatedAt),
    },
  };
}

export function conversationContextForAgent(conversation, {
  excludeSegmentId = null,
  allowedSegmentIds = null,
  limit = CONVERSATION_COMPACT_THRESHOLD,
} = {}) {
  const current = normalizeConversation(conversation);
  const allowed = Array.isArray(allowedSegmentIds) ? new Set(allowedSegmentIds) : null;
  const messages = current.messages
    .slice(firstUncompactedIndex(current))
    .filter((message) => !(excludeSegmentId && message.segmentId === excludeSegmentId))
    .filter((message) => !allowed || !message.segmentId || allowed.has(message.segmentId))
    .slice(-Math.max(1, limit));

  return {
    summary: current.compact.summary,
    messages,
  };
}

export function formatConversationTurns(messages) {
  return messages
    .map((message) => `${message.role === 'agent' ? '记忆助手' : '讲述者'}：${message.text}`)
    .join('\n');
}

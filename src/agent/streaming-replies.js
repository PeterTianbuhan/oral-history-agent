export function updateStreamingReplies(current, value, metadata = {}) {
  const replies = Array.isArray(current) ? current : [];
  const text = String(value ?? '');

  if (metadata.clearSegment) {
    return replies.filter((message) => message.segmentId !== metadata.segmentId);
  }

  const id = metadata.toolCallId;
  if (!id) return replies;
  if (metadata.done || !text) {
    return replies.filter((message) => message.id !== id);
  }

  const nextMessage = {
    id,
    text,
    role: 'agent',
    segmentId: metadata.segmentId ?? null,
    complete: Boolean(metadata.complete),
  };
  const index = replies.findIndex((message) => message.id === id);
  if (index < 0) return [...replies, nextMessage];
  if (
    replies[index].text === nextMessage.text
    && replies[index].complete === nextMessage.complete
  ) return replies;

  const next = [...replies];
  next[index] = { ...replies[index], ...nextMessage };
  return next;
}

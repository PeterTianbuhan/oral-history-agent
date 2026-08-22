import test from 'node:test';
import assert from 'node:assert/strict';
import {
  appendConversationMessage,
  applyConversationCompaction,
  conversationContextForAgent,
  emptyConversation,
  planConversationCompaction,
} from '../src/agent/conversation-context.js';

function conversationWith(count) {
  let conversation = emptyConversation();
  for (let index = 0; index < count; index += 1) {
    conversation = appendConversationMessage(conversation, {
      id: `message-${index}`,
      role: index % 2 === 0 ? 'narrator' : 'agent',
      text: `第 ${index + 1} 条`,
      segmentId: `segment-${Math.floor(index / 2)}`,
      createdAt: `2026-08-21T12:${String(index).padStart(2, '0')}:00.000Z`,
    });
  }
  return conversation;
}

test('compaction keeps the complete visible conversation and advances only the context cursor', () => {
  const conversation = conversationWith(28);
  const plan = planConversationCompaction(conversation, { threshold: 20, keepRecent: 8 });
  assert.equal(plan.messages.length, 20);
  assert.equal(plan.throughMessageId, 'message-19');

  const compacted = applyConversationCompaction(
    conversation,
    plan,
    '前面聊到了小时候住在河边。',
    '2026-08-21T13:00:00.000Z',
  );
  assert.equal(compacted.messages.length, 28);
  assert.equal(compacted.compact.throughMessageId, 'message-19');
  assert.equal(compacted.compact.summary, '前面聊到了小时候住在河边。');
});

test('Agent context contains the compact summary and recent turns without duplicating the current input', () => {
  const conversation = conversationWith(28);
  const plan = planConversationCompaction(conversation, { threshold: 20, keepRecent: 8 });
  const compacted = applyConversationCompaction(conversation, plan, '较早的对话摘要。');
  const context = conversationContextForAgent(compacted, {
    excludeSegmentId: 'segment-13',
  });

  assert.equal(context.summary, '较早的对话摘要。');
  assert.deepEqual(
    context.messages.map((message) => message.id),
    ['message-20', 'message-21', 'message-22', 'message-23', 'message-24', 'message-25'],
  );
});

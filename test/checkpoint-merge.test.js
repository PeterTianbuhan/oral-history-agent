import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeAgentCheckpoint } from '../src/agent/checkpoint-merge.js';

function memory(overrides = {}) {
  return {
    profile: { id: 'self' },
    timeline: [],
    peopleEntries: [],
    placeEntries: [],
    facts: [],
    evidence: [],
    agentJobs: [],
    ...overrides,
  };
}

test('checkpoint merge keeps direct prose edits and unrelated Agent fields', () => {
  const base = memory({
    timeline: [{ id: 't1', time: '小时候', text: '旧文字', evidenceIds: ['e1'] }],
  });
  const current = memory({
    timeline: [{ id: 't1', time: '小时候', text: '我亲手改过', evidenceIds: ['e1'] }],
  });
  const checkpoint = memory({
    timeline: [{
      id: 't1',
      time: '十岁左右',
      text: 'Agent 整理稿',
      evidenceIds: ['e1', 'e2'],
    }],
  });

  const result = mergeAgentCheckpoint(current, checkpoint, base);
  assert.deepEqual(result.timeline, [{
    id: 't1',
    time: '十岁左右',
    text: '我亲手改过',
    evidenceIds: ['e1', 'e2'],
  }]);
});

test('checkpoint merge respects a direct removal made during Agent work', () => {
  const item = { id: 't1', time: '小时候', text: '一段话' };
  const base = memory({ timeline: [item] });
  const current = memory({ timeline: [] });
  const checkpoint = memory({ timeline: [{ ...item, text: 'Agent 改写' }] });

  assert.deepEqual(mergeAgentCheckpoint(current, checkpoint, base).timeline, []);
});

test('checkpoint merge keeps a live reply while accepting a newer compact summary', () => {
  const base = memory({
    conversation: {
      messages: [{ id: 'user-one', role: 'narrator', text: '我小时候住河边。' }],
      compact: { summary: '', throughMessageId: null, updatedAt: null },
    },
  });
  const current = memory({
    conversation: {
      ...base.conversation,
      messages: [
        ...base.conversation.messages,
        { id: 'agent-one', role: 'agent', text: '我记得你刚才说到河边。' },
      ],
    },
  });
  const checkpoint = memory({
    conversation: {
      messages: base.conversation.messages,
      compact: {
        summary: '讲述者小时候住在河边。',
        throughMessageId: 'user-one',
        updatedAt: '2026-08-21T13:00:00.000Z',
      },
    },
  });

  const merged = mergeAgentCheckpoint(current, checkpoint, base);
  assert.deepEqual(merged.conversation.messages.map((message) => message.id), ['user-one', 'agent-one']);
  assert.equal(merged.conversation.compact.summary, '讲述者小时候住在河边。');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryTools } from '../src/agent/memory-tools.js';

function memoryFixture() {
  return {
    timeline: [{ id: 'one', time: '小时候', text: '我住在河边。' }],
    peopleEntries: [],
    placeEntries: [],
    facts: [],
    evidence: [{ id: 'evidence-one', rawText: '小时候住在河边。', correctedText: '小时候住在河边。' }],
    agentJobs: [],
  };
}

function toolByName(runtime, name) {
  return runtime.tools.find((tool) => tool.name === name);
}

test('write tool requires a search and exact read before changing an existing item', async () => {
  let memory = memoryFixture();
  const runtime = createMemoryTools({
    getMemory: () => memory,
    setMemory: (next) => { memory = next; },
    sourceEvidenceId: 'evidence-one',
    now: () => '2026-08-21T12:00:00.000Z',
  });
  const apply = toolByName(runtime, 'apply_memory_patch');
  const patch = {
    operations: [{ op: 'update', target: 'timeline_block', target_id: 'one', text: '小时候，我们住在河边。' }],
  };

  await assert.rejects(() => apply.execute('call-1', patch), /search_memory/);
  await toolByName(runtime, 'search_memory').execute('call-2', { keywords: ['河边'] });
  await assert.rejects(() => apply.execute('call-3', patch), /请先读取/);
  await toolByName(runtime, 'read_memory').execute('call-4', { ids: ['one'] });
  await apply.execute('call-5', patch);

  assert.equal(memory.timeline[0].text, '小时候，我们住在河边。');
  assert.deepEqual(runtime.snapshotAudit().readIds, ['one']);
  assert.equal(runtime.snapshotAudit().patches.length, 1);
});

test('speak tool emits only the requested message', async () => {
  let spoken = '';
  let spokenMetadata = null;
  const runtime = createMemoryTools({
    getMemory: memoryFixture,
    setMemory: () => {},
    onSpeak: (message, metadata) => {
      spoken = message;
      spokenMetadata = metadata;
    },
  });
  await toolByName(runtime, 'speak_to_narrator').execute('call', { message: '我已经把名字改好了。' });
  assert.equal(spoken, '我已经把名字改好了。');
  assert.deepEqual(spokenMetadata, { toolCallId: 'call' });
});

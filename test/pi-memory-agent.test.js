import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from '@earendil-works/pi-ai';
import {
  runMemoryAgent,
  streamedSpeakUpdate,
} from '../src/agent/pi-memory-agent.js';

test('streamed speak updates expose only visible tool arguments', () => {
  const visibleUpdate = streamedSpeakUpdate({
    type: 'message_update',
    assistantMessageEvent: {
      type: 'toolcall_delta',
      contentIndex: 0,
      partial: {
        content: [{
          type: 'toolCall',
          id: 'call-reply',
          name: 'speak_to_narrator',
          arguments: { message: '听到了，你慢慢说' },
        }],
      },
    },
  });
  const memorySearchUpdate = streamedSpeakUpdate({
    type: 'message_update',
    assistantMessageEvent: {
      type: 'toolcall_delta',
      contentIndex: 0,
      partial: {
        content: [{
          type: 'toolCall',
          id: 'call-search',
          name: 'search_memory',
          arguments: { keywords: ['河边'] },
        }],
      },
    },
  });

  assert.deepEqual(visibleUpdate, {
    toolCallId: 'call-reply',
    message: '听到了，你慢慢说',
    complete: false,
  });
  assert.equal(memorySearchUpdate, null);
});

test('Pi Core suspends at beforeToolCall, then completes its chosen memory tool loop', async () => {
  const faux = fauxProvider({ provider: 'memory-agent-test' });
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall('speak_to_narrator', { message: '听到了，你想把小时候住在河边这句话改得更完整。' }),
      { stopReason: 'toolUse' },
    ),
    fauxAssistantMessage(
      fauxToolCall('search_memory', { keywords: ['河边'], scopes: ['timeline', 'evidence'] }),
      { stopReason: 'toolUse' },
    ),
    fauxAssistantMessage(
      fauxToolCall('read_memory', { ids: ['timeline-one'], include_linked_evidence: true }),
      { stopReason: 'toolUse' },
    ),
    fauxAssistantMessage(
      fauxToolCall('apply_memory_patch', {
        operations: [{
          op: 'update',
          target: 'timeline_block',
          target_id: 'timeline-one',
          text: '小时候，我们就住在河边。',
        }],
      }),
      { stopReason: 'toolUse' },
    ),
    fauxAssistantMessage(
      fauxToolCall('speak_to_narrator', { message: '我把这句话轻轻顺了一下。' }),
      { stopReason: 'toolUse' },
    ),
    fauxAssistantMessage(fauxText('完成。')),
  ]);

  const startingMemory = {
      version: 2,
      profile: { id: 'self', title: '我的一生' },
      timeline: [{
        id: 'timeline-one',
        time: '小时候',
        text: '小时候就住河边。',
        evidenceIds: ['evidence-one'],
      }],
      peopleEntries: [],
      placeEntries: [],
      facts: [],
      evidence: [{
        id: 'evidence-one',
        segmentId: 'segment-one',
        rawText: '小时候我们就住在河边。',
        correctedText: '小时候我们就住在河边。',
      }],
      agentJobs: [],
    };
  const directlyEditedMemory = JSON.parse(JSON.stringify(startingMemory));
  directlyEditedMemory.timeline[0].time = '十岁左右';
  const toolSets = [];

  let releaseEdit;
  let reportSuspended;
  let settled = false;
  const checkpoints = [];
  const editFinished = new Promise((resolve) => { releaseEdit = resolve; });
  const suspendedAtToolBarrier = new Promise((resolve) => { reportSuspended = resolve; });
  const run = runMemoryAgent({
    memory: startingMemory,
    job: {
      segmentId: 'segment-one',
      evidenceId: 'evidence-one',
      transcript: '把小时候那段改成“小时候，我们就住在河边”。',
      section: 'life',
    },
    config: { maxTurns: 8, thinkingLevel: 'off', baseUrl: '', apiKey: '', model: {} },
    model: faux.getModel(),
    streamFn: (activeModel, context, options) => {
      toolSets.push((context.tools ?? []).map((tool) => tool.name));
      return models.streamSimple(activeModel, context, options);
    },
    systemPromptText: '维护用户的记忆；使用给定工具完成任务。',
    beforeToolCall: async () => {
      reportSuspended();
      await editFinished;
      return directlyEditedMemory;
    },
    onCheckpoint: async (checkpoint) => checkpoints.push(checkpoint),
    now: () => '2026-08-21T12:00:00.000Z',
  }).then((value) => {
    settled = true;
    return value;
  });

  await suspendedAtToolBarrier;
  assert.equal(settled, false);
  assert.equal(faux.state.callCount, 1);
  releaseEdit();
  const result = await run;

  assert.equal(result.memory.timeline[0].text, '小时候，我们就住在河边。');
  assert.equal(result.memory.timeline[0].time, '十岁左右');
  assert.equal(result.message, '我把这句话轻轻顺了一下。');
  assert.equal(result.assistantText, '完成。');
  assert.deepEqual(result.audit.messages, [
    '听到了，你想把小时候住在河边这句话改得更完整。',
    '我把这句话轻轻顺了一下。',
  ]);
  assert.deepEqual(toolSets[0], ['speak_to_narrator']);
  assert.ok(toolSets.slice(1).every((names) => names.includes('search_memory')));
  assert.equal(result.audit.searches.length, 1);
  assert.deepEqual(result.audit.readIds, ['timeline-one', 'evidence-one']);
  assert.equal(result.audit.patches.length, 1);
  assert.ok(checkpoints.some((checkpoint) => (
    checkpoint.timeline[0].text === '小时候，我们就住在河边。'
  )));
  assert.equal(faux.state.callCount, 6);
});

test('Pi Core compacts old dialogue without deleting the visible history', async () => {
  const faux = fauxProvider({ provider: 'memory-agent-compact-test' });
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall('speak_to_narrator', { message: '好，我们接着说。' }),
      { stopReason: 'toolUse' },
    ),
    fauxAssistantMessage(fauxText('本轮完成。')),
    fauxAssistantMessage(fauxText('此前主要谈到小时候的家庭生活。')),
  ]);

  const messages = Array.from({ length: 26 }, (_, index) => ({
    id: `message-${index}`,
    role: index % 2 === 0 ? 'narrator' : 'agent',
    text: `第 ${index + 1} 条对话`,
    segmentId: `old-${Math.floor(index / 2)}`,
    createdAt: `2026-08-21T11:${String(index).padStart(2, '0')}:00.000Z`,
  }));
  const job = {
    id: 'agent-segment-current',
    segmentId: 'segment-current',
    transcript: '今天接着说。',
    section: 'chat',
    status: 'running',
  };
  const startingMemory = {
    version: 2,
    profile: { id: 'self', title: '我的一生' },
    timeline: [],
    peopleEntries: [],
    placeEntries: [],
    facts: [],
    evidence: [],
    conversation: {
      version: 1,
      messages,
      compact: { summary: '', throughMessageId: null, updatedAt: null },
    },
    agentJobs: [job],
  };
  const checkpoints = [];

  const result = await runMemoryAgent({
    memory: startingMemory,
    job,
    config: { maxTurns: 4, thinkingLevel: 'off', baseUrl: '', apiKey: '', model: {} },
    model: faux.getModel(),
    streamFn: models.streamSimple.bind(models),
    systemPromptText: '处理当前输入。',
    onCheckpoint: async (checkpoint) => checkpoints.push(checkpoint),
    now: () => '2026-08-21T12:00:00.000Z',
  });

  assert.equal(result.memory.conversation.messages.length, 26);
  assert.equal(result.memory.conversation.compact.summary, '此前主要谈到小时候的家庭生活。');
  assert.equal(result.memory.conversation.compact.throughMessageId, 'message-15');
  assert.equal(result.assistantText, '本轮完成。');
  assert.deepEqual(result.audit.messages, ['好，我们接着说。']);
  assert.ok(checkpoints.some((checkpoint) => checkpoint.conversation.compact.summary));
  assert.equal(faux.state.callCount, 3);
});

test('Pi Core keeps memory tools hidden until the initial short reply is delivered', async () => {
  const faux = fauxProvider({ provider: 'memory-agent-initial-reply-test' });
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([
    fauxAssistantMessage(fauxText('我先直接整理。')),
    fauxAssistantMessage(
      fauxToolCall('speak_to_narrator', { message: '听到了，你慢慢说。' }),
      { stopReason: 'toolUse' },
    ),
    fauxAssistantMessage(fauxText('继续处理。')),
  ]);

  const toolSets = [];
  const result = await runMemoryAgent({
    memory: {
      version: 2,
      profile: { id: 'self', title: '我的一生' },
      timeline: [],
      peopleEntries: [],
      placeEntries: [],
      facts: [],
      evidence: [],
      conversation: {
        version: 1,
        messages: [],
        compact: { summary: '', throughMessageId: null, updatedAt: null },
      },
      agentJobs: [],
    },
    job: {
      segmentId: 'segment-reply-first',
      transcript: '我想起小时候的一件事。',
      section: 'chat',
    },
    config: { maxTurns: 4, thinkingLevel: 'off', baseUrl: '', apiKey: '', model: {} },
    model: faux.getModel(),
    streamFn: (activeModel, context, options) => {
      toolSets.push((context.tools ?? []).map((tool) => tool.name));
      return models.streamSimple(activeModel, context, options);
    },
    systemPromptText: '帮助用户维护记忆。',
  });

  assert.deepEqual(result.audit.messages, ['听到了，你慢慢说。']);
  assert.deepEqual(toolSets[0], ['speak_to_narrator']);
  assert.deepEqual(toolSets[1], ['speak_to_narrator']);
  assert.ok(toolSets[2].includes('search_memory'));
  assert.equal(faux.state.callCount, 3);
});

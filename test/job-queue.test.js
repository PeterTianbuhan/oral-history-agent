import test from 'node:test';
import assert from 'node:assert/strict';
import {
  claimNextAgentJob,
  completeAgentJob,
  createAgentJob,
  enqueueAgentJob,
  normalizeAgentJobs,
  recoverAgentJobs,
} from '../src/agent/job-queue.js';
import { processAgentQueue } from '../src/agent/agent-service.js';

test('segment jobs are idempotent and running jobs recover as pending', () => {
  const job = createAgentJob({
    segmentId: 'segment-one',
    evidenceId: 'evidence-one',
    transcript: '我小时候住在河边。',
    section: 'life',
  }, '2026-08-21T12:00:00.000Z');
  const jobs = enqueueAgentJob(enqueueAgentJob([], job), job);
  assert.equal(jobs.length, 1);

  const claimed = claimNextAgentJob(jobs, '2026-08-21T12:01:00.000Z');
  assert.equal(claimed.job.status, 'running');
  assert.equal(claimed.job.attempts, 1);
  assert.equal(normalizeAgentJobs(claimed.jobs)[0].status, 'pending');
  assert.equal(completeAgentJob(claimed.jobs, job.id)[0].status, 'applied');
  assert.equal(recoverAgentJobs([{ ...job, status: 'failed' }])[0].status, 'pending');
});

test('agent service processes jobs sequentially with checkpointed states', async () => {
  const first = createAgentJob({ segmentId: 'one', transcript: '第一段' }, '2026-08-21T12:00:00.000Z');
  const second = createAgentJob({ segmentId: 'two', transcript: '第二段' }, '2026-08-21T12:00:01.000Z');
  const order = [];
  const checkpoints = [];
  const replies = [];
  const result = await processAgentQueue({
    memory: {
      timeline: [],
      peopleEntries: [],
      placeEntries: [],
      facts: [],
      evidence: [],
      agentJobs: [first, second],
    },
    config: { agent: {} },
    onCheckpoint: (memory) => checkpoints.push(memory.agentJobs.map((job) => job.status)),
    onSpeak: (message, metadata) => replies.push({ message, metadata }),
    runAgent: async ({ memory, job }) => {
      order.push(job.segmentId);
      return {
        memory: {
          ...memory,
          timeline: [...memory.timeline, { id: job.segmentId, time: '刚刚', text: job.transcript }],
        },
        assistantText: `自然回应 ${job.segmentId}`,
        audit: {},
      };
    },
  });

  assert.deepEqual(order, ['one', 'two']);
  assert.deepEqual(result.memory.agentJobs.map((job) => job.status), ['applied', 'applied']);
  assert.deepEqual(result.memory.timeline.map((entry) => entry.id), ['one', 'two']);
  assert.ok(checkpoints.length >= 4);
  assert.deepEqual(replies.map((reply) => reply.message), ['自然回应 one', '自然回应 two']);
  assert.deepEqual(replies.map((reply) => reply.metadata.segmentId), ['one', 'two']);
  assert.ok(replies.every((reply) => reply.metadata.fromAssistantText));
});

test('agent service publishes tool checkpoints before the job completes', async () => {
  const job = createAgentJob({ segmentId: 'one', transcript: '第一段' });
  const snapshots = [];
  await processAgentQueue({
    memory: {
      timeline: [],
      peopleEntries: [],
      placeEntries: [],
      facts: [],
      evidence: [],
      agentJobs: [job],
    },
    config: { agent: {} },
    onCheckpoint: (memory) => snapshots.push(memory.timeline.map((entry) => entry.id)),
    runAgent: async ({ memory, onCheckpoint }) => {
      const changed = {
        ...memory,
        timeline: [{ id: 'tool-write', time: '刚刚', text: '工具刚刚写入' }],
      };
      await onCheckpoint(changed);
      return { memory: changed, audit: { patches: [{}] } };
    },
  });

  assert.ok(snapshots.some((snapshot) => snapshot.includes('tool-write')));
});

test('agent service forwards temporary reply metadata and clears it after the job', async () => {
  const job = createAgentJob({ segmentId: 'one', transcript: '第一段' });
  const partials = [];
  const replies = [];
  await processAgentQueue({
    memory: {
      timeline: [],
      peopleEntries: [],
      placeEntries: [],
      facts: [],
      evidence: [],
      agentJobs: [job],
    },
    config: { agent: {} },
    onSpeakPartial: (message, metadata) => partials.push({ message, metadata }),
    onSpeak: (message, metadata) => replies.push({ message, metadata }),
    runAgent: async ({ memory, job: activeJob, onSpeakPartial, onSpeak }) => {
      onSpeakPartial('听到', { toolCallId: 'call-one' });
      await onSpeak('听到了。', { toolCallId: 'call-one' });
      return { memory, audit: { messages: ['听到了。'] } };
    },
  });

  assert.deepEqual(partials[0], {
    message: '听到',
    metadata: {
      jobId: job.id,
      segmentId: 'one',
      toolCallId: 'call-one',
    },
  });
  assert.deepEqual(partials.at(-1), {
    message: '',
    metadata: {
      jobId: job.id,
      segmentId: 'one',
      clearSegment: true,
    },
  });
  assert.deepEqual(replies, [{
    message: '听到了。',
    metadata: {
      jobId: job.id,
      segmentId: 'one',
      toolCallId: 'call-one',
    },
  }]);
});

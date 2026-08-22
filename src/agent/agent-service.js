import {
  claimNextAgentJob,
  completeAgentJob,
  failAgentJob,
} from './job-queue.js';

function fallbackReplies(locale) {
  if (locale === 'en') {
    return {
      changed: 'I heard you. I have organized this part.',
      heard: 'I heard you.',
      delayed: 'I heard you. This part is saved, and I will organize it later.',
    };
  }
  if (locale === 'zh-TW') {
    return {
      changed: '我聽到了，這一段已經整理好了。',
      heard: '我聽到了。',
      delayed: '我聽到了。這一段已經留下，稍後再整理。',
    };
  }
  return {
    changed: '我听到了，这一段已经整理好了。',
    heard: '我听到了。',
    delayed: '我听到了。这一段已经留下，稍后再整理。',
  };
}

export async function processAgentQueue({
  memory,
  config,
  onCheckpoint = async () => {},
  onSpeak = () => {},
  onSpeakPartial = () => {},
  beforeAgentAction = async () => {},
  maxAttempts = 3,
  maxJobs = Number.POSITIVE_INFINITY,
  runAgent,
} = {}) {
  let current = JSON.parse(JSON.stringify(memory));
  const processed = [];
  const executeAgent = runAgent
    ?? (await import('./pi-memory-agent.js')).runMemoryAgent;

  while (processed.length < maxJobs) {
    const claimed = claimNextAgentJob(current.agentJobs);
    if (!claimed.job) break;
    current.agentJobs = claimed.jobs;
    await onCheckpoint(current);
    let replyCount = 0;
    const alreadyReplied = current.conversation?.messages?.some((message) => (
      message.role === 'agent' && message.segmentId === claimed.job.segmentId
    )) ?? false;
    const speakForJob = async (message, metadata = {}) => {
      replyCount += 1;
      await onSpeak(message, {
        jobId: claimed.job.id,
        segmentId: claimed.job.segmentId,
        ...metadata,
      });
    };
    const speakPartialForJob = (message, metadata = {}) => onSpeakPartial(message, {
      jobId: claimed.job.id,
      segmentId: claimed.job.segmentId,
      ...metadata,
    });

    try {
      const fallback = fallbackReplies(claimed.job.locale);
      const result = await executeAgent({
        memory: current,
        job: claimed.job,
        config: config.agent,
        onSpeak: speakForJob,
        onSpeakPartial: speakPartialForJob,
        beforeToolCall: beforeAgentAction,
        onCheckpoint: async (checkpoint) => {
          current = checkpoint;
          await onCheckpoint(current);
        },
      });
      current = result.memory;
      if (replyCount === 0 && !alreadyReplied) {
        const changedMemory = (result.audit?.patches?.length ?? 0) > 0;
        const naturalReply = typeof result.assistantText === 'string'
          ? result.assistantText.trim()
          : '';
        await speakForJob(
          naturalReply || (changedMemory ? fallback.changed : fallback.heard),
          { fallback: true, fromAssistantText: Boolean(naturalReply) },
        );
      }
      current.agentJobs = completeAgentJob(current.agentJobs, claimed.job.id);
      processed.push({ jobId: claimed.job.id, ok: true, audit: result.audit });
      await onCheckpoint(current);
    } catch (error) {
      if (replyCount === 0 && !alreadyReplied) {
        await speakForJob(fallbackReplies(claimed.job.locale).delayed, { fallback: true });
      }
      const retry = claimed.job.attempts < maxAttempts;
      current.agentJobs = failAgentJob(current.agentJobs, claimed.job.id, error, { retry });
      processed.push({
        jobId: claimed.job.id,
        ok: false,
        retry,
        error: error instanceof Error ? error.message : String(error),
      });
      await onCheckpoint(current);
      break;
    } finally {
      try {
        await onSpeakPartial('', {
          jobId: claimed.job.id,
          segmentId: claimed.job.segmentId,
          clearSegment: true,
        });
      } catch {
        // A transient UI update must never change the durable Agent result.
      }
    }
  }

  return { memory: current, processed };
}

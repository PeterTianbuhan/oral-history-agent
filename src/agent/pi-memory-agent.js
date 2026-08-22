import { createMemoryTools } from './memory-tools.js';
import { mergeAgentCheckpoint } from './checkpoint-merge.js';
import { Type } from 'typebox';
import {
  applyConversationCompaction,
  conversationContextForAgent,
  formatConversationTurns,
  planConversationCompaction,
} from './conversation-context.js';

async function bundledSystemPrompt() {
  return (await import('../../prompts/memory-curator.system.md?raw')).default;
}

function configuredModel(config) {
  const model = config.model;
  return {
    id: model.id,
    name: model.name || model.id,
    api: model.api || 'openai-completions',
    provider: model.provider || 'aliyun-bailian',
    baseUrl: config.baseUrl,
    reasoning: model.reasoning !== false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: Number(model.contextWindow) || 131072,
    maxTokens: Number(model.maxTokens) || 8192,
    ...(model.compat ? { compat: model.compat } : {}),
    ...(model.headers ? { headers: model.headers } : {}),
  };
}

function jobContextBoundaries(memory, job) {
  const jobs = Array.isArray(memory.agentJobs) ? memory.agentJobs : [];
  const index = jobs.findIndex((candidate) => candidate.segmentId === job.segmentId);
  if (index < 0) return { priorSegmentIds: null, blockedSegmentIds: [job.segmentId] };
  return {
    priorSegmentIds: jobs.slice(0, index).map((candidate) => candidate.segmentId),
    blockedSegmentIds: jobs.slice(index).map((candidate) => candidate.segmentId),
  };
}

function runPrompt(job, memory) {
  const sectionLabels = {
    chat: '聊一聊',
    life: '我的一生',
    people: '我认识的人',
    places: '我去过的地方',
  };
  const boundaries = jobContextBoundaries(memory, job);
  const localeLabels = { 'zh-CN': '简体中文', 'zh-TW': '繁體中文', en: 'English' };
  const context = conversationContextForAgent(memory.conversation, {
    excludeSegmentId: job.segmentId,
    allowedSegmentIds: boundaries.priorSegmentIds,
  });
  return [
    '下面的摘要和最近对话只帮助你接着聊，不是人生事实的权威来源。需要确认或修改记忆时，仍然使用搜索和读取工具。',
    context.summary ? `较早对话的 compact 摘要：\n${context.summary}` : null,
    context.messages.length > 0
      ? `最近对话：\n${formatConversationTurns(context.messages)}`
      : null,
    '',
    `当前输入：${job.transcript}`,
    job.evidenceId ? `原始证据 ID：${job.evidenceId}` : null,
    `用户当前所在界面：${sectionLabels[job.section] ?? job.section ?? '未知'}`,
    job.selectedId ? `用户当前选中的内容 ID：${job.selectedId}` : null,
    `界面语言：${localeLabels[job.locale] ?? job.locale ?? '简体中文'}。回应优先跟随讲述者当前使用的语言；无法判断时使用界面语言。整理内容时保留讲述者原有语言，不要擅自翻译。`,
    '',
    '处理这次输入。不要默认它是人生故事。',
    '先调用 speak_to_narrator，用一句简短、自然、贴合当前输入的话接住用户。这句只表示你听到了：不要追问、展开、总结整段，也不要声称尚未完成的整理已经完成。',
    '首次回应不是任务结束。完成它以后，自由决定接下来怎样工作。需要改变记录时，主动选择关键词搜索；搜索结果不足可以换词继续搜。修改已有内容或指定时间线位置前，读取准确目标。用户明确想把现有讲述记下来时，先按已经说出的信息维护，不要因为以后还能补充细节就停下来等待。你也可以根据需要继续调用 speak_to_narrator 发第二条或更多消息。',
  ].filter((line) => line !== null).join('\n');
}

function lastAssistantText(messages) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== 'assistant' || !Array.isArray(message.content)) continue;
    const text = message.content
      .filter((part) => part?.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text)
      .join('')
      .trim();
    if (text) return text;
  }
  return '';
}

export function streamedSpeakUpdate(event) {
  if (event?.type !== 'message_update') return null;
  const streamEvent = event.assistantMessageEvent;
  if (!['toolcall_delta', 'toolcall_end'].includes(streamEvent?.type)) return null;
  const toolCall = streamEvent.partial?.content?.[streamEvent.contentIndex];
  if (
    toolCall?.type !== 'toolCall'
    || toolCall.name !== 'speak_to_narrator'
    || typeof toolCall.id !== 'string'
    || !toolCall.id
    || typeof toolCall.arguments?.message !== 'string'
  ) return null;
  const message = toolCall.arguments.message.replace(/^\s+/, '');
  if (!message) return null;
  return {
    toolCallId: toolCall.id,
    message,
    complete: streamEvent.type === 'toolcall_end',
  };
}

async function compactConversation({
  Agent,
  memory,
  job,
  model,
  streamFn,
  config,
  now,
}) {
  const boundaries = jobContextBoundaries(memory, job);
  const plan = planConversationCompaction(memory.conversation, {
    stopBeforeSegmentIds: boundaries.blockedSegmentIds,
  });
  if (!plan) return { memory, compacted: false };

  const compactAgent = new Agent({
    initialState: {
      systemPrompt: [
        '你负责压缩一段持续对话，供下一轮继续交流。',
        '只保留对话延续所需的信息：已经谈到的主题、用户明确的要求和纠正、尚未回应的线头、双方已达成的理解。',
        '不要把猜测变成事实，不要替代原始对话、时间线、人物地点卡片或事实库。',
        `使用讲述者对话中的主要语言输出一份独立摘要；无法判断时使用 ${job.locale ?? 'zh-CN'}。不要解释你的工作。`,
      ].join('\n'),
      model,
      thinkingLevel: config.compactThinkingLevel ?? 'low',
      tools: [],
      messages: [],
    },
    streamFn,
    sessionId: `${job.segmentId}-compact`,
    toolExecution: 'sequential',
  });

  try {
    await compactAgent.prompt([
      plan.previousSummary ? `已有摘要：\n${plan.previousSummary}` : '已有摘要：无',
      `需要并入的对话：\n${formatConversationTurns(plan.messages)}`,
      '',
      '输出更新后的完整摘要，中文控制在 600 个汉字以内，其他语言控制在 350 个单词以内。',
    ].join('\n'));
    if (compactAgent.state.errorMessage) throw new Error(compactAgent.state.errorMessage);
    const summary = lastAssistantText(compactAgent.state.messages);
    if (!summary) return { memory, compacted: false };
    const updatedAt = typeof now === 'function' ? now() : new Date().toISOString();
    return {
      memory: {
        ...memory,
        conversation: applyConversationCompaction(
          memory.conversation,
          plan,
          summary,
          updatedAt,
        ),
      },
      compacted: true,
    };
  } finally {
    compactAgent.reset();
  }
}

export async function runMemoryAgent({
  memory,
  job,
  config,
  onSpeak = () => {},
  onSpeakPartial = () => {},
  beforeToolCall = async () => {},
  onCheckpoint = async () => {},
  streamFn: injectedStreamFn,
  model: injectedModel,
  systemPromptText,
  now,
  idFactory,
} = {}) {
  if (!memory || !job || !config) throw new Error('memory-agent-input-required');

  let workingMemory = JSON.parse(JSON.stringify(memory));
  let externalBase = JSON.parse(JSON.stringify(memory));
  const activeSpeakStreams = new Set();
  const partialTextByToolCall = new Map();
  const publishSpeakPartial = (message, metadata) => {
    try {
      const pending = onSpeakPartial(message, metadata);
      if (pending && typeof pending.catch === 'function') pending.catch(() => {});
    } catch {
      // Streaming is an ephemeral UI hint and must never interrupt memory maintenance.
    }
  };
  const pauseAndSyncBeforeTool = async () => {
    const latestMemory = await beforeToolCall();
    if (!latestMemory || typeof latestMemory !== 'object') return;
    workingMemory = mergeAgentCheckpoint(latestMemory, workingMemory, externalBase);
    externalBase = JSON.parse(JSON.stringify(latestMemory));
  };
  const toolRuntime = createMemoryTools({
    getMemory: () => workingMemory,
    setMemory: async (next) => {
      workingMemory = next;
      await onCheckpoint(JSON.parse(JSON.stringify(next)));
    },
    sourceEvidenceId: job.evidenceId,
    onSpeak: async (message, metadata = {}) => {
      if (metadata.toolCallId) activeSpeakStreams.delete(metadata.toolCallId);
      await onSpeak(message, metadata);
    },
    now,
    idFactory,
  });

  const { Agent } = await import('@earendil-works/pi-agent-core');
  const activeSystemPrompt = systemPromptText ?? await bundledSystemPrompt();
  const model = injectedModel ?? configuredModel(config);
  let streamFn = injectedStreamFn;
  if (!streamFn) {
    const direct = await import('@earendil-works/pi-ai/api/openai-completions');
    streamFn = (activeModel, context, options) => direct.streamSimple(
      activeModel,
      context,
      { ...options, apiKey: config.apiKey },
    );
  }

  let turns = 0;
  const maxTurns = Math.max(2, Math.min(Number(config.maxTurns) || 12, 24));
  const speakTool = toolRuntime.tools.find((tool) => tool.name === 'speak_to_narrator');
  if (!speakTool) throw new Error('speak-to-narrator-tool-required');
  const initialSpeakTool = {
    ...speakTool,
    description: '本轮首次回应。只用一句简短、自然、贴合当前输入的话表示你听到了；不要追问、展开、总结整段或声称整理已完成。',
    parameters: Type.Object({
      message: Type.String({ minLength: 1, maxLength: 80 }),
    }, { additionalProperties: false }),
  };
  const agent = new Agent({
    initialState: {
      systemPrompt: activeSystemPrompt,
      model,
      thinkingLevel: config.initialReplyThinkingLevel ?? 'low',
      tools: [initialSpeakTool],
      messages: [],
    },
    streamFn,
    sessionId: job.segmentId,
    toolExecution: 'sequential',
    beforeToolCall: pauseAndSyncBeforeTool,
    shouldStopAfterTurn: () => turns >= maxTurns,
    prepareNextTurnWithContext: ({ context }) => {
      if (toolRuntime.audit.messages.length === 0) return undefined;
      if ((context.tools ?? []).length === toolRuntime.tools.length) return undefined;
      return {
        context: {
          ...context,
          tools: toolRuntime.tools,
        },
        thinkingLevel: config.thinkingLevel ?? 'high',
      };
    },
  });

  const unsubscribe = agent.subscribe((event) => {
    if (event.type === 'turn_start') turns += 1;
    const streamedReply = streamedSpeakUpdate(event);
    if (streamedReply) {
      const previous = partialTextByToolCall.get(streamedReply.toolCallId);
      if (previous !== streamedReply.message) {
        partialTextByToolCall.set(streamedReply.toolCallId, streamedReply.message);
        activeSpeakStreams.add(streamedReply.toolCallId);
        publishSpeakPartial(streamedReply.message, {
          toolCallId: streamedReply.toolCallId,
          segmentId: job.segmentId,
          complete: streamedReply.complete,
        });
      }
    }
    if (event.type === 'tool_execution_end' && event.toolName === 'speak_to_narrator') {
      activeSpeakStreams.delete(event.toolCallId);
      partialTextByToolCall.delete(event.toolCallId);
      publishSpeakPartial('', {
        toolCallId: event.toolCallId,
        segmentId: job.segmentId,
        done: true,
        error: event.isError,
      });
    }
    if (
      event.type === 'turn_end'
      && toolRuntime.audit.messages.length === 0
      && turns < maxTurns
    ) {
      agent.followUp('先使用 speak_to_narrator 给用户一句简短、自然的回应，再继续处理。');
    }
  });

  try {
    await agent.prompt(runPrompt(job, workingMemory));
    if (agent.state.errorMessage) throw new Error(agent.state.errorMessage);
    const assistantText = lastAssistantText(agent.state.messages);
    try {
      const compacted = await compactConversation({
        Agent,
        memory: workingMemory,
        job,
        model,
        streamFn,
        config,
        now,
      });
      workingMemory = compacted.memory;
      if (compacted.compacted) await onCheckpoint(JSON.parse(JSON.stringify(workingMemory)));
    } catch {
      // Compaction happens after the visible reply and must never lose the current turn.
    }
    return {
      memory: workingMemory,
      message: toolRuntime.audit.messages.at(-1) ?? '',
      assistantText,
      audit: toolRuntime.snapshotAudit(),
      turns,
    };
  } finally {
    for (const toolCallId of activeSpeakStreams) {
      publishSpeakPartial('', {
        toolCallId,
        segmentId: job.segmentId,
        done: true,
        aborted: true,
      });
    }
    unsubscribe();
    agent.reset();
  }
}

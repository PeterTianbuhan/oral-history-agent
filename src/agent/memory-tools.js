import { Type } from 'typebox';
import {
  applyMemoryPatch,
  readMemory,
  readTimelineWindow,
  searchMemory,
} from '../memory/memory-engine.js';

const nullableString = Type.Union([Type.String(), Type.Null()]);
const operationSchema = Type.Object({
  op: Type.Union([
    Type.Literal('add'),
    Type.Literal('update'),
    Type.Literal('remove'),
    Type.Literal('move'),
    Type.Literal('merge'),
    Type.Literal('upsert'),
  ]),
  target: Type.Union([
    Type.Literal('timeline_block'),
    Type.Literal('person'),
    Type.Literal('place'),
    Type.Literal('fact'),
  ]),
  target_id: Type.Optional(nullableString),
  after_id: Type.Optional(nullableString),
  merge_from_ids: Type.Optional(Type.Array(Type.String(), { uniqueItems: true })),
  time_label: Type.Optional(nullableString),
  title: Type.Optional(nullableString),
  text: Type.Optional(nullableString),
  value: Type.Optional(Type.Union([Type.String(), Type.Number(), Type.Boolean(), Type.Null()])),
  evidence_ids: Type.Optional(Type.Array(Type.String(), { uniqueItems: true })),
  reason: Type.Optional(nullableString),
}, { additionalProperties: false });

function toolResult(value, details = {}) {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    details,
  };
}

function referencedIds(operation) {
  const ids = [];
  if (operation.op !== 'add' && operation.target_id) ids.push(operation.target_id);
  if (operation.after_id) ids.push(operation.after_id);
  if (Array.isArray(operation.merge_from_ids)) ids.push(...operation.merge_from_ids);
  return [...new Set(ids)];
}

export function createMemoryTools({
  getMemory,
  setMemory,
  sourceEvidenceId = null,
  onSpeak = () => {},
  now = () => new Date().toISOString(),
  idFactory,
} = {}) {
  if (typeof getMemory !== 'function' || typeof setMemory !== 'function') {
    throw new Error('memory-tool-store-required');
  }

  const audit = {
    searches: [],
    readIds: new Set(),
    patches: [],
    messages: [],
  };

  const tools = [
    {
      name: 'search_memory',
      label: '搜索记忆',
      description: '使用一组关键词检索当前时间线、人物、地点、事实和原始转录。命中任意关键词即可返回，并优先排列命中关键词更多的内容。工具不扩写关键词；结果不足时请自行换词继续搜索。',
      parameters: Type.Object({
        keywords: Type.Array(Type.String({ minLength: 1 }), {
          minItems: 1,
          maxItems: 12,
          uniqueItems: true,
        }),
        scopes: Type.Optional(Type.Array(Type.Union([
          Type.Literal('timeline'),
          Type.Literal('people'),
          Type.Literal('places'),
          Type.Literal('facts'),
          Type.Literal('evidence'),
        ]), { uniqueItems: true })),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
      }, { additionalProperties: false }),
      executionMode: 'parallel',
      execute: async (_toolCallId, params) => {
        const results = searchMemory(getMemory(), params);
        audit.searches.push({
          keywords: [...params.keywords],
          scopes: params.scopes ? [...params.scopes] : null,
          resultIds: results.map((result) => result.id),
        });
        return toolResult({ results }, { count: results.length });
      },
    },
    {
      name: 'read_memory',
      label: '读取记忆',
      description: '按稳定 ID 读取当前记忆的准确内容及其关联原话。搜索摘要只用于定位，修改已有内容前必须调用此工具读取目标。',
      parameters: Type.Object({
        ids: Type.Array(Type.String(), { minItems: 1, maxItems: 20, uniqueItems: true }),
        include_linked_evidence: Type.Optional(Type.Boolean()),
      }, { additionalProperties: false }),
      executionMode: 'parallel',
      execute: async (_toolCallId, params) => {
        const result = readMemory(getMemory(), {
          ids: params.ids,
          includeLinkedEvidence: params.include_linked_evidence,
        });
        result.items.forEach((item) => audit.readIds.add(item.id));
        return toolResult(result, { count: result.items.length, notFound: result.notFound });
      },
    },
    {
      name: 'read_timeline_window',
      label: '读取时间线附近内容',
      description: '读取某个时间线段落及其前后相邻段落，用来判断插入、合并、移动和自然语言时间顺序。',
      parameters: Type.Object({
        anchor_id: Type.String(),
        before: Type.Optional(Type.Integer({ minimum: 0, maximum: 6 })),
        after: Type.Optional(Type.Integer({ minimum: 0, maximum: 6 })),
      }, { additionalProperties: false }),
      executionMode: 'parallel',
      execute: async (_toolCallId, params) => {
        const result = readTimelineWindow(getMemory(), {
          anchorId: params.anchor_id,
          before: params.before,
          after: params.after,
        });
        result.entries.forEach((entry) => audit.readIds.add(entry.id));
        return toolResult(result, { count: result.entries.length });
      },
    },
    {
      name: 'apply_memory_patch',
      label: '修改记忆',
      description: '原子地新增、修改、删除、移动、合并或更新当前时间线、人物、地点和事实。只保留修改后的当前内容。任何操作失败时整组变更都不会写入。',
      parameters: Type.Object({
        operations: Type.Array(operationSchema, { minItems: 1, maxItems: 30 }),
      }, { additionalProperties: false }),
      executionMode: 'sequential',
      execute: async (_toolCallId, params) => {
        if (audit.searches.length === 0) {
          throw new Error('修改记忆前请先使用 search_memory 搜索相关内容');
        }
        const unreadIds = params.operations
          .flatMap(referencedIds)
          .filter((id) => !audit.readIds.has(id));
        if (unreadIds.length > 0) {
          throw new Error(`修改前请先读取这些目标：${[...new Set(unreadIds)].join('、')}`);
        }

        const result = applyMemoryPatch(getMemory(), params, {
          sourceEvidenceId,
          now: now(),
          idFactory,
        });
        await setMemory(result.memory);
        audit.patches.push({ operations: params.operations, changes: result.changes });
        return toolResult({ changes: result.changes }, { count: result.changes.length });
      },
    },
    {
      name: 'speak_to_narrator',
      label: '回应用户',
      description: '给用户发一条界面消息。本轮第一次调用时先用简短、自然的话接住用户；之后可以在任何合适的时机回应、追问或确认，也可以在一轮中多次调用。消息正文会在调用时原样显示给用户。',
      parameters: Type.Object({
        message: Type.String({ minLength: 1, maxLength: 2000 }),
      }, { additionalProperties: false }),
      executionMode: 'sequential',
      execute: async (toolCallId, params) => {
        const message = params.message.trim();
        if (!message) throw new Error('message-required');
        audit.messages.push(message);
        await onSpeak(message, { toolCallId });
        return toolResult({ delivered: true }, { messageLength: message.length });
      },
    },
  ];

  return {
    tools,
    audit,
    snapshotAudit() {
      return {
        searches: audit.searches.map((search) => ({ ...search })),
        readIds: [...audit.readIds],
        patches: audit.patches.map((patch) => ({ ...patch })),
        messages: [...audit.messages],
      };
    },
  };
}

const TARGET_COLLECTIONS = {
  timeline_block: 'timeline',
  person: 'peopleEntries',
  place: 'placeEntries',
  fact: 'facts',
};

const SCOPE_TARGETS = {
  timeline: 'timeline_block',
  people: 'person',
  places: 'place',
  facts: 'fact',
  evidence: 'evidence',
};

const TARGET_PREFIXES = {
  timeline_block: 'memory',
  person: 'person',
  place: 'place',
  fact: 'fact',
};

const OP_NAMES = new Set(['add', 'update', 'remove', 'move', 'merge', 'upsert']);
const TARGET_NAMES = new Set(Object.keys(TARGET_COLLECTIONS));

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function normalizeSearchText(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .toLocaleLowerCase('zh-CN')
    .replace(/\s+/g, ' ')
    .trim();
}

function entryDocument(target, entry) {
  if (target === 'timeline_block') {
    return {
      id: entry.id,
      target,
      scope: 'timeline',
      title: entry.time ?? '',
      text: [entry.text, entry.rawText].filter(Boolean).join('\n'),
      linkedIds: entry.evidenceIds ?? [],
      sortKey: entry.order ?? 0,
    };
  }

  if (target === 'person' || target === 'place') {
    return {
      id: entry.id,
      target,
      scope: target === 'person' ? 'people' : 'places',
      title: entry.time ?? entry.title ?? '',
      text: entry.text ?? '',
      linkedIds: entry.evidenceIds ?? [],
      sortKey: entry.updatedAt ?? '',
    };
  }

  if (target === 'fact') {
    return {
      id: entry.id,
      target,
      scope: 'facts',
      title: entry.kind ?? entry.title ?? '',
      text: String(entry.value ?? ''),
      linkedIds: entry.evidenceIds ?? [],
      sortKey: entry.updatedAt ?? '',
    };
  }

  return {
    id: entry.id,
    target: 'evidence',
    scope: 'evidence',
    title: entry.capturedAt ?? entry.segmentId ?? '',
    text: [entry.correctedText, entry.rawText].filter(Boolean).join('\n'),
    linkedIds: entry.segmentId ? [entry.segmentId] : [],
    sortKey: entry.capturedAt ?? '',
  };
}

function allSearchDocuments(memory, scopes) {
  const requestedScopes = new Set(
    Array.isArray(scopes) && scopes.length > 0
      ? scopes.filter((scope) => Object.hasOwn(SCOPE_TARGETS, scope))
      : Object.keys(SCOPE_TARGETS),
  );
  const documents = [];

  for (const [scope, target] of Object.entries(SCOPE_TARGETS)) {
    if (!requestedScopes.has(scope)) continue;
    const collection = target === 'evidence'
      ? memory.evidence
      : memory[TARGET_COLLECTIONS[target]];
    for (const entry of Array.isArray(collection) ? collection : []) {
      if (nonEmptyString(entry?.id)) documents.push(entryDocument(target, entry));
    }
  }

  return documents;
}

function excerptAround(text, keyword, maxLength = 180) {
  const raw = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (raw.length <= maxLength) return raw;

  const normalized = normalizeSearchText(raw);
  const index = normalized.indexOf(normalizeSearchText(keyword));
  const center = index >= 0 ? index : 0;
  const start = Math.max(0, center - Math.floor(maxLength / 3));
  const end = Math.min(raw.length, start + maxLength);
  return `${start > 0 ? '…' : ''}${raw.slice(start, end)}${end < raw.length ? '…' : ''}`;
}

export function searchMemory(memory, { keywords, scopes, limit = 8 } = {}) {
  const normalizedKeywords = [...new Set(
    (Array.isArray(keywords) ? keywords : [])
      .map((keyword) => String(keyword ?? '').trim())
      .filter(Boolean),
  )].slice(0, 12);

  if (normalizedKeywords.length === 0) {
    throw new Error('search-memory-keywords-required');
  }

  const safeLimit = Math.max(1, Math.min(Number(limit) || 8, 20));
  const documents = allSearchDocuments(memory, scopes);

  return documents
    .map((document, sourceIndex) => {
      const title = normalizeSearchText(document.title);
      const body = normalizeSearchText(document.text);
      const matchedKeywords = normalizedKeywords.filter((keyword) => {
        const needle = normalizeSearchText(keyword);
        return needle.length > 0 && (title.includes(needle) || body.includes(needle));
      });
      if (matchedKeywords.length === 0) return null;

      const exactTitleMatches = matchedKeywords.filter(
        (keyword) => title === normalizeSearchText(keyword),
      ).length;
      const titleMatches = matchedKeywords.filter(
        (keyword) => title.includes(normalizeSearchText(keyword)),
      ).length;

      return {
        id: document.id,
        type: document.target,
        title: document.title,
        excerpt: excerptAround(document.text, matchedKeywords[0]),
        matchedKeywords,
        linkedIds: document.linkedIds,
        _rank: [matchedKeywords.length, exactTitleMatches, titleMatches, -sourceIndex],
      };
    })
    .filter(Boolean)
    .sort((left, right) => {
      for (let index = 0; index < left._rank.length; index += 1) {
        const difference = right._rank[index] - left._rank[index];
        if (difference !== 0) return difference;
      }
      return left.id.localeCompare(right.id, 'zh-CN');
    })
    .slice(0, safeLimit)
    .map(({ _rank, ...result }) => result);
}

function findMemoryItem(memory, id) {
  for (const [target, collectionName] of Object.entries(TARGET_COLLECTIONS)) {
    const collection = Array.isArray(memory[collectionName]) ? memory[collectionName] : [];
    const item = collection.find((entry) => entry.id === id);
    if (item) return { target, item };
  }

  const evidence = (Array.isArray(memory.evidence) ? memory.evidence : [])
    .find((entry) => entry.id === id);
  return evidence ? { target: 'evidence', item: evidence } : null;
}

export function readMemory(memory, { ids, includeLinkedEvidence = false } = {}) {
  const requestedIds = [...new Set(Array.isArray(ids) ? ids : [])].slice(0, 20);
  if (requestedIds.length === 0) throw new Error('read-memory-ids-required');

  const items = [];
  const notFound = [];
  const linkedEvidenceIds = new Set();

  for (const id of requestedIds) {
    const found = findMemoryItem(memory, id);
    if (!found) {
      notFound.push(id);
      continue;
    }
    items.push({ id, type: found.target, value: clone(found.item) });
    if (includeLinkedEvidence && Array.isArray(found.item.evidenceIds)) {
      found.item.evidenceIds.forEach((evidenceId) => linkedEvidenceIds.add(evidenceId));
    }
  }

  if (includeLinkedEvidence) {
    for (const evidenceId of linkedEvidenceIds) {
      if (requestedIds.includes(evidenceId)) continue;
      const found = findMemoryItem(memory, evidenceId);
      if (found?.target === 'evidence') {
        items.push({ id: evidenceId, type: 'evidence', value: clone(found.item) });
      }
    }
  }

  return { items, notFound };
}

export function readTimelineWindow(memory, { anchorId, before = 2, after = 2 } = {}) {
  if (!nonEmptyString(anchorId)) throw new Error('timeline-anchor-required');
  const timeline = Array.isArray(memory.timeline) ? memory.timeline : [];
  const anchorIndex = timeline.findIndex((entry) => entry.id === anchorId);
  if (anchorIndex < 0) throw new Error('timeline-anchor-not-found');

  const safeBefore = Math.max(0, Math.min(Number(before) || 0, 6));
  const safeAfter = Math.max(0, Math.min(Number(after) || 0, 6));
  const start = Math.max(0, anchorIndex - safeBefore);
  const end = Math.min(timeline.length, anchorIndex + safeAfter + 1);

  return {
    anchorId,
    start,
    total: timeline.length,
    entries: clone(timeline.slice(start, end)),
  };
}

function createId(target, idFactory) {
  const suffix = idFactory
    ? idFactory(target)
    : globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${TARGET_PREFIXES[target]}-${suffix}`;
}

function collectionFor(memory, target) {
  const collectionName = TARGET_COLLECTIONS[target];
  if (!collectionName) throw new Error(`unsupported-memory-target:${target}`);
  if (!Array.isArray(memory[collectionName])) memory[collectionName] = [];
  return memory[collectionName];
}

function requireTargetItem(memory, target, targetId) {
  if (!nonEmptyString(targetId)) throw new Error(`target-id-required:${target}`);
  const collection = collectionFor(memory, target);
  const index = collection.findIndex((entry) => entry.id === targetId);
  if (index < 0) throw new Error(`memory-target-not-found:${target}:${targetId}`);
  return { collection, index, item: collection[index] };
}

function mergedEvidenceIds(existing, incoming, sourceEvidenceId) {
  return [...new Set([
    ...(Array.isArray(existing) ? existing : []),
    ...(Array.isArray(incoming) ? incoming : []),
    ...(nonEmptyString(sourceEvidenceId) ? [sourceEvidenceId] : []),
  ])];
}

function operationFields(operation, existing, sourceEvidenceId, now) {
  const next = { ...(existing ?? {}) };
  if (operation.time_label !== undefined && operation.time_label !== null) {
    next.time = String(operation.time_label).trim();
  }
  if (operation.title !== undefined && operation.title !== null) {
    next.time = String(operation.title).trim();
  }
  if (operation.text !== undefined && operation.text !== null) {
    next.text = String(operation.text).trim();
  }
  if (operation.value !== undefined && operation.value !== null) {
    next.value = operation.value;
  }
  next.evidenceIds = mergedEvidenceIds(existing?.evidenceIds, operation.evidence_ids, sourceEvidenceId);
  next.updatedAt = now;
  next.fresh = true;
  if ((operation.target === 'person' || operation.target === 'place') && next.evidenceIds.length > 0) {
    next.count = next.evidenceIds.length;
  }
  return next;
}

function validateContent(target, item) {
  if (target === 'timeline_block') {
    if (!nonEmptyString(item.time)) item.time = '记不清具体什么时候';
    if (!nonEmptyString(item.text)) throw new Error('timeline-text-required');
  } else if (target === 'person' || target === 'place') {
    if (!nonEmptyString(item.time)) throw new Error(`${target}-title-required`);
    if (!nonEmptyString(item.text)) item.text = '';
  } else if (target === 'fact') {
    if (!nonEmptyString(item.kind) && nonEmptyString(item.time)) item.kind = item.time;
    delete item.time;
    if (!nonEmptyString(item.kind)) throw new Error('fact-kind-required');
    if (item.value === undefined || item.value === null || item.value === '') {
      throw new Error('fact-value-required');
    }
  }
}

function insertAfter(collection, item, afterId) {
  if (afterId === null) {
    collection.unshift(item);
    return;
  }
  if (afterId === undefined) {
    collection.push(item);
    return;
  }
  const afterIndex = collection.findIndex((entry) => entry.id === afterId);
  if (afterIndex < 0) throw new Error(`after-id-not-found:${afterId}`);
  collection.splice(afterIndex + 1, 0, item);
}

function addOperation(memory, operation, context) {
  const { target } = operation;
  const collection = collectionFor(memory, target);
  const id = nonEmptyString(operation.target_id)
    ? operation.target_id
    : createId(target, context.idFactory);
  if (collection.some((entry) => entry.id === id)) {
    throw new Error(`memory-id-already-exists:${id}`);
  }

  const base = {
    id,
    createdAt: context.now,
    ...(target === 'fact' ? { kind: operation.title ?? '' } : {}),
  };
  const item = operationFields(operation, base, context.sourceEvidenceId, context.now);
  validateContent(target, item);

  if (target === 'timeline_block') insertAfter(collection, item, operation.after_id);
  else collection.unshift(item);
  return { op: 'add', target, targetId: id };
}

function updateOperation(memory, operation, context) {
  const found = requireTargetItem(memory, operation.target, operation.target_id);
  const item = operationFields(operation, found.item, context.sourceEvidenceId, context.now);
  if (operation.target === 'fact' && nonEmptyString(operation.title)) item.kind = operation.title.trim();
  validateContent(operation.target, item);
  found.collection[found.index] = item;
  return { op: 'update', target: operation.target, targetId: item.id };
}

function removeOperation(memory, operation) {
  const found = requireTargetItem(memory, operation.target, operation.target_id);
  const [removed] = found.collection.splice(found.index, 1);
  return { op: 'remove', target: operation.target, targetId: removed.id };
}

function moveOperation(memory, operation) {
  if (operation.target !== 'timeline_block') throw new Error('move-only-supports-timeline');
  const found = requireTargetItem(memory, operation.target, operation.target_id);
  const [item] = found.collection.splice(found.index, 1);
  if (operation.after_id === item.id) throw new Error('cannot-move-after-self');
  insertAfter(found.collection, item, operation.after_id);
  return { op: 'move', target: operation.target, targetId: item.id, afterId: operation.after_id ?? null };
}

function mergeOperation(memory, operation, context) {
  const found = requireTargetItem(memory, operation.target, operation.target_id);
  const sourceIds = [...new Set(Array.isArray(operation.merge_from_ids) ? operation.merge_from_ids : [])]
    .filter((id) => id !== operation.target_id);
  if (sourceIds.length === 0) throw new Error('merge-source-ids-required');
  const sources = sourceIds.map((id) => requireTargetItem(memory, operation.target, id).item);
  const combinedEvidence = sources.flatMap((item) => item.evidenceIds ?? []);
  const item = operationFields(
    { ...operation, evidence_ids: [...combinedEvidence, ...(operation.evidence_ids ?? [])] },
    found.item,
    context.sourceEvidenceId,
    context.now,
  );
  if (operation.target === 'fact' && nonEmptyString(operation.title)) item.kind = operation.title.trim();
  validateContent(operation.target, item);
  found.collection[found.index] = item;
  for (const sourceId of sourceIds) {
    const index = found.collection.findIndex((entry) => entry.id === sourceId);
    if (index >= 0) found.collection.splice(index, 1);
  }
  return { op: 'merge', target: operation.target, targetId: item.id, mergedIds: sourceIds };
}

function validateOperation(operation) {
  if (!operation || typeof operation !== 'object') throw new Error('invalid-memory-operation');
  if (!OP_NAMES.has(operation.op)) throw new Error(`unsupported-memory-operation:${operation.op}`);
  if (!TARGET_NAMES.has(operation.target)) throw new Error(`unsupported-memory-target:${operation.target}`);
}

export function applyMemoryPatch(
  memory,
  patch,
  { sourceEvidenceId = null, now = new Date().toISOString(), idFactory } = {},
) {
  const operations = patch?.operations;
  if (!Array.isArray(operations) || operations.length === 0) {
    throw new Error('memory-patch-operations-required');
  }

  const next = clone(memory);
  next.timeline = (next.timeline ?? []).map((entry) => ({ ...entry, fresh: false }));
  next.peopleEntries = (next.peopleEntries ?? []).map((entry) => ({ ...entry, fresh: false }));
  next.placeEntries = (next.placeEntries ?? []).map((entry) => ({ ...entry, fresh: false }));
  next.facts = next.facts ?? [];
  next.evidence = next.evidence ?? [];

  const context = { sourceEvidenceId, now, idFactory };
  const changes = [];
  for (const operation of operations) {
    validateOperation(operation);
    if (operation.op === 'add') changes.push(addOperation(next, operation, context));
    else if (operation.op === 'update') changes.push(updateOperation(next, operation, context));
    else if (operation.op === 'remove') changes.push(removeOperation(next, operation));
    else if (operation.op === 'move') changes.push(moveOperation(next, operation));
    else if (operation.op === 'merge') changes.push(mergeOperation(next, operation, context));
    else if (operation.op === 'upsert') {
      const collection = collectionFor(next, operation.target);
      const exists = nonEmptyString(operation.target_id)
        && collection.some((entry) => entry.id === operation.target_id);
      changes.push(exists
        ? updateOperation(next, { ...operation, op: 'update' }, context)
        : addOperation(next, { ...operation, op: 'add' }, context));
    }
  }

  next.updatedAt = now;
  return { memory: next, changes };
}

export function memoryItemExists(memory, id) {
  return Boolean(findMemoryItem(memory, id));
}

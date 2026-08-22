import { normalizeConversation } from './conversation-context.js';

function sameValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function mergeById(primary, secondary) {
  const merged = new Map();
  for (const item of Array.isArray(primary) ? primary : []) merged.set(item.id, item);
  for (const item of Array.isArray(secondary) ? secondary : []) {
    merged.set(item.id, { ...(merged.get(item.id) ?? {}), ...item });
  }
  return [...merged.values()];
}

function mergeChangedFields(baseItem, currentItem, checkpointItem) {
  if (!baseItem) return { ...checkpointItem, ...currentItem };

  const merged = { ...checkpointItem };
  const keys = new Set([
    ...Object.keys(baseItem),
    ...Object.keys(currentItem),
    ...Object.keys(checkpointItem),
  ]);

  for (const key of keys) {
    const userChangedField = !sameValue(currentItem[key], baseItem[key]);
    if (!userChangedField) continue;
    if (Object.prototype.hasOwnProperty.call(currentItem, key)) merged[key] = currentItem[key];
    else delete merged[key];
  }

  return merged;
}

function mergeConversation(baseValue, currentValue, checkpointValue) {
  const base = normalizeConversation(baseValue);
  const current = normalizeConversation(currentValue);
  const checkpoint = normalizeConversation(checkpointValue);
  const compact = sameValue(current.compact, base.compact)
    ? checkpoint.compact
    : current.compact;

  return {
    version: 1,
    messages: mergeById(checkpoint.messages, current.messages),
    compact,
  };
}

export function mergeDerivedCollection(baseItems = [], currentItems = [], checkpointItems = []) {
  const base = new Map(baseItems.map((item) => [item.id, item]));
  const current = new Map(currentItems.map((item) => [item.id, item]));
  const checkpoint = new Map(checkpointItems.map((item) => [item.id, item]));
  const merged = [];

  for (const checkpointItem of checkpointItems) {
    const baseItem = base.get(checkpointItem.id);
    const currentItem = current.get(checkpointItem.id);

    // The user removed an item while the Agent was working.
    if (!currentItem && baseItem) continue;
    merged.push(currentItem
      ? mergeChangedFields(baseItem, currentItem, checkpointItem)
      : checkpointItem);
  }

  for (const currentItem of currentItems) {
    if (checkpoint.has(currentItem.id)) continue;
    const baseItem = base.get(currentItem.id);

    // Keep a user-created item, or an item the user edited while the Agent removed it.
    if (!baseItem || !sameValue(currentItem, baseItem)) merged.push(currentItem);
  }

  return merged;
}

export function mergeAgentCheckpoint(current, checkpoint, base = current) {
  return {
    ...current,
    ...checkpoint,
    profile: current.profile,
    timeline: mergeDerivedCollection(base.timeline, current.timeline, checkpoint.timeline),
    peopleEntries: mergeDerivedCollection(
      base.peopleEntries,
      current.peopleEntries,
      checkpoint.peopleEntries,
    ),
    placeEntries: mergeDerivedCollection(
      base.placeEntries,
      current.placeEntries,
      checkpoint.placeEntries,
    ),
    facts: mergeDerivedCollection(base.facts, current.facts, checkpoint.facts),
    evidence: mergeById(checkpoint.evidence, current.evidence),
    conversation: mergeConversation(base.conversation, current.conversation, checkpoint.conversation),
    agentJobs: mergeById(current.agentJobs, checkpoint.agentJobs),
  };
}

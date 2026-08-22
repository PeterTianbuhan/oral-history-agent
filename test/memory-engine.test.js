import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyMemoryPatch,
  readMemory,
  readTimelineWindow,
  searchMemory,
} from '../src/memory/memory-engine.js';

function sampleMemory() {
  return {
    version: 2,
    profile: { id: 'self', title: '我的一生' },
    timeline: [
      { id: 'childhood', time: '小时候', text: '我常常去河边玩。', evidenceIds: ['evidence-1'] },
      { id: 'school', time: '十七八岁那年夏天', text: '我离开家去县城读中专。', evidenceIds: ['evidence-2'] },
      { id: 'work', time: '后来参加工作', text: '我在县城的工厂里上班。', evidenceIds: ['evidence-3'] },
    ],
    peopleEntries: [
      { id: 'person-teacher', time: '王老师', text: '中专时的班主任。' },
    ],
    placeEntries: [
      { id: 'place-county', time: '县城', text: '读书和工作过的地方。' },
    ],
    facts: [
      { id: 'fact-teacher-name', kind: 'name', value: '王老师' },
    ],
    evidence: [
      { id: 'evidence-1', segmentId: 'one', rawText: '小时候总去河边。', correctedText: '小时候总去河边。' },
      { id: 'evidence-2', segmentId: 'two', rawText: '十七八岁去县城读中专。', correctedText: '十七八岁去县城读中专。' },
      { id: 'evidence-3', segmentId: 'three', rawText: '后来又在县城工厂上班。', correctedText: '后来又在县城工厂上班。' },
    ],
    agentJobs: [],
  };
}

test('keyword search returns literal matches ranked by keyword coverage', () => {
  const results = searchMemory(sampleMemory(), {
    keywords: ['县城', '中专'],
    scopes: ['timeline', 'places', 'evidence'],
  });

  assert.equal(results[0].id, 'school');
  assert.deepEqual(results[0].matchedKeywords, ['县城', '中专']);
  assert.ok(results.some((result) => result.id === 'work'));
  assert.ok(results.every((result) => !result.matchedKeywords.includes('读书同义词')));
});

test('keyword search does not expand synonyms or invent semantic matches', () => {
  const results = searchMemory(sampleMemory(), { keywords: ['求学'] });
  assert.deepEqual(results, []);
});

test('read returns exact current objects and linked evidence', () => {
  const result = readMemory(sampleMemory(), {
    ids: ['school', 'missing'],
    includeLinkedEvidence: true,
  });
  assert.deepEqual(result.notFound, ['missing']);
  assert.deepEqual(result.items.map((item) => item.id), ['school', 'evidence-2']);
  assert.equal(result.items[0].value.text, '我离开家去县城读中专。');
});

test('timeline window preserves linear order around an anchor', () => {
  const result = readTimelineWindow(sampleMemory(), { anchorId: 'school', before: 1, after: 1 });
  assert.deepEqual(result.entries.map((entry) => entry.id), ['childhood', 'school', 'work']);
});

test('patch applies add, update and move atomically', () => {
  const original = sampleMemory();
  let sequence = 0;
  const result = applyMemoryPatch(original, {
    operations: [
      {
        op: 'add',
        target: 'timeline_block',
        after_id: 'school',
        time_label: '毕业以后',
        text: '我先在家里待了一阵。',
      },
      {
        op: 'update',
        target: 'person',
        target_id: 'person-teacher',
        text: '王老师是我中专时的班主任。',
      },
      {
        op: 'move',
        target: 'timeline_block',
        target_id: 'work',
        after_id: null,
      },
    ],
  }, {
    sourceEvidenceId: 'evidence-new',
    now: '2026-08-21T12:00:00.000Z',
    idFactory: () => `test-${sequence += 1}`,
  });

  assert.deepEqual(result.memory.timeline.map((entry) => entry.id), [
    'work',
    'childhood',
    'school',
    'memory-test-1',
  ]);
  assert.equal(result.memory.peopleEntries[0].text, '王老师是我中专时的班主任。');
  assert.ok(result.memory.peopleEntries[0].evidenceIds.includes('evidence-new'));
  assert.equal(original.peopleEntries[0].text, '中专时的班主任。');
});

test('a failed operation leaves the source memory untouched', () => {
  const original = sampleMemory();
  const before = JSON.stringify(original);
  assert.throws(() => applyMemoryPatch(original, {
    operations: [
      { op: 'update', target: 'timeline_block', target_id: 'school', text: '先修改。' },
      { op: 'remove', target: 'person', target_id: 'does-not-exist' },
    ],
  }), /memory-target-not-found/);
  assert.equal(JSON.stringify(original), before);
});

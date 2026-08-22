import test from 'node:test';
import assert from 'node:assert/strict';
import { sectionToMarkdown } from '../src/platform/memory-store.js';

const memory = {
  timeline: [{ time: '那个夏天', text: '我第一次离开家。' }],
  peopleEntries: [{ time: '王老师', text: '她教我写自己的名字。' }],
  placeEntries: [{ time: '河边', text: '孩子们总爱去那里。' }],
  evidence: [{ audioUri: 'file:///private/recordings/secret.wav' }],
};

test('life Markdown contains only organized timeline content', () => {
  const markdown = sectionToMarkdown(memory, 'life');
  assert.match(markdown, /^# 我的一生/m);
  assert.match(markdown, /## 那个夏天/);
  assert.match(markdown, /我第一次离开家。/);
  assert.doesNotMatch(markdown, /audioUri|secret\.wav|王老师|河边/);
});

test('people and places export independently', () => {
  const people = sectionToMarkdown(memory, 'people');
  const places = sectionToMarkdown(memory, 'places');
  assert.match(people, /^# 我认识的人/m);
  assert.match(people, /## 王老师/);
  assert.doesNotMatch(people, /河边|secret\.wav/);
  assert.match(places, /^# 我去过的地方/m);
  assert.match(places, /## 河边/);
  assert.doesNotMatch(places, /王老师|secret\.wav/);
});

test('Markdown headings follow the selected UI language', () => {
  assert.match(sectionToMarkdown(memory, 'life', 'en'), /^# My Life/m);
  assert.match(sectionToMarkdown(memory, 'people', 'zh-TW'), /^# 我認識的人/m);
});

test('chat is intentionally not a Markdown export surface', () => {
  assert.throws(
    () => sectionToMarkdown(memory, 'chat'),
    /unsupported-markdown-section:chat/,
  );
});

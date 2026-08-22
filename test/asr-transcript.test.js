import test from 'node:test';
import assert from 'node:assert/strict';
import {
  qwenPartialText,
  resolveSegmentTranscript,
} from '../src/asr/transcript.js';

test('Qwen stable text and mutable stash form the visible transcript', () => {
  assert.equal(qwenPartialText({ text: '我小时候', stash: '住在余姚' }), '我小时候住在余姚');
});

test('a narrator correction wins over the later ASR final result', () => {
  assert.equal(resolveSegmentTranscript({
    visibleText: '我小时候住在余姚。',
    finalizedText: '我小时候住在余杭。',
    userCorrected: true,
  }), '我小时候住在余姚。');
  assert.equal(resolveSegmentTranscript({
    visibleText: '我小时候住在余',
    finalizedText: '我小时候住在余姚。',
    userCorrected: false,
  }), '我小时候住在余姚。');
});

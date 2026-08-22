import test from 'node:test';
import assert from 'node:assert/strict';
import { updateStreamingReplies } from '../src/agent/streaming-replies.js';

test('streaming replies update independently and settle without duplicates', () => {
  let replies = updateStreamingReplies([], '听', {
    toolCallId: 'call-one',
    segmentId: 'segment-one',
  });
  replies = updateStreamingReplies(replies, '我', {
    toolCallId: 'call-two',
    segmentId: 'segment-one',
  });
  replies = updateStreamingReplies(replies, '听到了。', {
    toolCallId: 'call-one',
    segmentId: 'segment-one',
    complete: true,
  });

  assert.deepEqual(replies.map(({ id, text }) => ({ id, text })), [
    { id: 'call-one', text: '听到了。' },
    { id: 'call-two', text: '我' },
  ]);

  replies = updateStreamingReplies(replies, '', {
    toolCallId: 'call-one',
    done: true,
  });
  assert.deepEqual(replies.map(({ id, text }) => ({ id, text })), [
    { id: 'call-two', text: '我' },
  ]);

  replies = updateStreamingReplies(replies, '', {
    segmentId: 'segment-one',
    clearSegment: true,
  });
  assert.deepEqual(replies, []);
});

test('streaming replies ignore events without a stable tool call id', () => {
  const current = [{
    id: 'call-one',
    text: '听到了。',
    role: 'agent',
    segmentId: 'segment-one',
    complete: false,
  }];
  assert.equal(updateStreamingReplies(current, '内部文字', {}), current);
});

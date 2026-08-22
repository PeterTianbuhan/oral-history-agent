import test from 'node:test';
import assert from 'node:assert/strict';
import {
  registerAsrProvider,
  startAsrSession,
} from '../src/asr/asr-runtime.js';

test('ASR lifecycle is provider-independent', async () => {
  const events = [];
  registerAsrProvider(async ({ onPartial, onFinal }) => ({
    async start() {
      events.push('start');
      onPartial('正在说');
    },
    async cutSegment() {
      events.push('cut');
      onFinal('这一段说完了');
      return '这一段说完了';
    },
    async stop() {
      events.push('stop');
      return '最后一段';
    },
  }));

  const transcripts = [];
  const session = await startAsrSession({
    config: { enabled: true },
    onPartial: (text) => transcripts.push(text),
    onFinal: (text) => transcripts.push(text),
  });
  assert.equal(await session.cutSegment(), '这一段说完了');
  assert.equal(await session.stop(), '最后一段');
  assert.deepEqual(events, ['start', 'cut', 'stop']);
  assert.deepEqual(transcripts, ['正在说', '这一段说完了']);
  registerAsrProvider(null);
});

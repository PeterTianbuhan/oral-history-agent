import test from 'node:test';
import assert from 'node:assert/strict';

import { uiCopy } from '../src/i18n.js';

test('onboarding describes a direct provider connection without implying an app server', () => {
  const subtitles = ['zh-CN', 'zh-TW', 'en'].map((locale) => uiCopy(locale).settings.subtitle);

  assert.match(subtitles[0], /直接连接/);
  assert.match(subtitles[1], /直接連接/);
  assert.match(subtitles[2], /connects directly/i);
  assert.equal(subtitles.some((subtitle) => /我们的服务器|我們的伺服器|our server/i.test(subtitle)), false);
});

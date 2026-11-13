import assert from 'node:assert/strict';
import test from 'node:test';

import { DraftStore } from '../webview/src/chat/drafts.ts';

test('черновик на сессию: переключение не теряет текст', () => {
  const drafts = new DraftStore();
  drafts.set('sess-a', 'черновик A');
  drafts.set('sess-b', 'черновик B');

  assert.equal(drafts.get('sess-a'), 'черновик A');
  assert.equal(drafts.get('sess-b'), 'черновик B');
  assert.equal(drafts.get('sess-c'), '');
  assert.equal(drafts.get(null), '');

  drafts.set('sess-a', '');
  assert.equal(drafts.get('sess-a'), '');
  assert.equal(drafts.size, 1);
});

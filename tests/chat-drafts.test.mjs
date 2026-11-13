import assert from 'node:assert/strict';
import test from 'node:test';

import { DraftStore, switchSessionDraft } from '../webview/src/chat/drafts.ts';

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

test('switchSessionDraft сохраняет старый и возвращает новый черновик', () => {
  const drafts = new DraftStore();
  drafts.set('sess-a', 'старый A');

  assert.equal(switchSessionDraft(drafts, 'sess-a', 'sess-b', 'текущий A'), '');
  assert.equal(drafts.get('sess-a'), 'текущий A');
  assert.equal(drafts.get('sess-b'), '');

  drafts.set('sess-b', 'B');
  assert.equal(switchSessionDraft(drafts, 'sess-b', 'sess-a', 'текущий B'), 'текущий A');
  assert.equal(drafts.get('sess-b'), 'текущий B');
});

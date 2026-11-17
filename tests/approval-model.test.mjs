import assert from 'node:assert/strict';
import test from 'node:test';

import {
  approvalActions,
  approvalHasDiff,
  formatApprovalArguments,
  handleApprovalKey,
  nextFocusIndex
} from '../webview/src/approvals/approvalModel.ts';

test('действия карточки: три решения и опциональный diff', () => {
  assert.deepEqual(
    approvalActions(false).map((action) => action.id),
    ['allow', 'allow-session', 'deny']
  );
  assert.deepEqual(
    approvalActions(true).map((action) => action.id),
    ['allow', 'allow-session', 'deny', 'show-diff']
  );
  assert.equal(approvalActions(false)[0]?.primary, true);
});

test('фокус-ловушка: Tab/стрелки ходят по кругу', () => {
  assert.equal(nextFocusIndex(0, 3, 1), 1);
  assert.equal(nextFocusIndex(2, 3, 1), 0);
  assert.equal(nextFocusIndex(0, 3, -1), 2);
  assert.equal(nextFocusIndex(0, 0, 1), 0);

  const actions = approvalActions(true);
  assert.deepEqual(handleApprovalKey('Tab', 3, actions), { kind: 'focus', index: 0 });
  assert.deepEqual(handleApprovalKey('Tab', 0, actions, { shift: true }), {
    kind: 'focus',
    index: 3
  });
  assert.deepEqual(handleApprovalKey('ArrowRight', 0, actions), { kind: 'focus', index: 1 });
  assert.deepEqual(handleApprovalKey('ArrowLeft', 0, actions), { kind: 'focus', index: 3 });
});

test('клавиатура: Esc — отклонить, Enter — действие под фокусом', () => {
  const actions = approvalActions(true);

  assert.deepEqual(handleApprovalKey('Escape', 0, actions), {
    kind: 'decision',
    decision: 'deny'
  });
  assert.deepEqual(handleApprovalKey('Enter', 0, actions), {
    kind: 'decision',
    decision: 'allow'
  });
  assert.deepEqual(handleApprovalKey('Enter', 1, actions), {
    kind: 'decision',
    decision: 'allow-session'
  });
  assert.deepEqual(handleApprovalKey('Enter', 2, actions), {
    kind: 'decision',
    decision: 'deny'
  });
  assert.deepEqual(handleApprovalKey('Enter', 3, actions), { kind: 'show-diff' });
  assert.equal(handleApprovalKey('q', 0, actions), null);
});

test('diff показывается только для записи с путём', () => {
  assert.equal(approvalHasDiff({ kind: 'write', targetPath: 'a.ts' }), true);
  assert.equal(approvalHasDiff({ kind: 'write' }), false);
  assert.equal(approvalHasDiff({ kind: 'network', targetPath: 'a.ts' }), false);
});

test('аргументы форматируются как текст с ограничением длины', () => {
  assert.equal(formatApprovalArguments(undefined), '');
  assert.match(formatApprovalArguments({ path: 'a.ts' }), /"path": "a\.ts"/);
  assert.equal(formatApprovalArguments({ long: 'x'.repeat(100) }, 40).length, 41);
});

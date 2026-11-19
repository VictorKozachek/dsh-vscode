import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BOARD_STATUSES,
  boardCounts,
  buildBoardData,
  cardBadges
} from '../webview/src/board/boardModel.ts';

const plugin = { installed: false, profile: 'acp', installCommand: 'dsh plugin --profile acp add x' };

const card = (id, extra = {}) => ({
  id,
  title: `Задача ${id}`,
  status: 'todo',
  owner: '',
  branch: '',
  updated: '2026-11-19T10:00:00Z',
  inBranch: false,
  path: `/t/${id}.md`,
  ...extra
});

test('buildBoardData: 8 колонок в порядке, счётчики, пустое состояние', () => {
  const data = buildBoardData(
    [
      { status: 'todo', cards: [card('1')] },
      { status: 'in-progress', cards: [card('2', { owner: 'session-1' })] }
    ],
    plugin
  );
  assert.deepEqual(data.columns.map((column) => column.status), [...BOARD_STATUSES]);
  assert.equal(data.empty, false);
  const counts = boardCounts(data);
  assert.equal(counts.todo, 1);
  assert.equal(counts['in-progress'], 1);
  assert.equal(counts.merged, 0);

  const empty = buildBoardData([], plugin);
  assert.equal(empty.empty, true);
  assert.equal(empty.columns.length, 8);
});

test('cardBadges: owner/branch/в ветке', () => {
  assert.deepEqual(cardBadges(card('1')), []);
  assert.deepEqual(
    cardBadges(
      card('2', { owner: 'session-9', branch: 'task/036', inBranch: true })
    ),
    ['owner: session-9', 'branch: task/036', 'в ветке']
  );
});

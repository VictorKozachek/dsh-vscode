import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  branchBadge,
  groupKanbanCards,
  loadKanbanCards,
  mergeKanbanCards,
  parseFrontMatter,
  parseKanbanCard
} from '../extension/src/views/kanban.ts';
import { buildKanbanColumns } from '../webview/src/kanban/kanbanModel.ts';

const CARD = `---
id: "014"
title: "Kanban-панель расширения"
status: in-progress
owner: session-1
branch: task/014
updated: 2026-11-17T16:00:00Z
---

## Задача
Показать доску.
`;

test('parseKanbanCard: front matter, кириллица, заголовок', () => {
  const card = parseKanbanCard(CARD, '/repo/.kanban/tasks/014.md');
  assert.equal(card.id, '014');
  assert.equal(card.title, 'Kanban-панель расширения');
  assert.equal(card.status, 'in-progress');
  assert.equal(card.owner, 'session-1');
  assert.equal(card.branch, 'task/014');
  assert.equal(card.inBranch, false);
});

test('parseKanbanCard: битый front matter не бросает, статус/ошибка', () => {
  const broken = `---
id: 015
title: Без кавычек
status: ???
---
тело
`;
  const card = parseKanbanCard(broken, '/repo/.kanban/tasks/015.md');
  assert.equal(card.id, '015');
  assert.equal(card.status, 'backlog');
  assert.match(card.parseError ?? '', /неизвестный статус/);

  const noFront = parseKanbanCard('# Заголовок\n', '/repo/.kanban/tasks/016.md');
  assert.equal(noFront.id, '016');
  assert.equal(noFront.title, 'Заголовок');
  assert.deepEqual(parseFrontMatter('без front matter'), {});
});

test('merge/group: worktree-копия помечается и перекрывает main по updated', () => {
  const main = parseKanbanCard(CARD.replace('16:00:00Z', '15:00:00Z'), '/repo/.kanban/tasks/014.md');
  const branch = parseKanbanCard(CARD, '/repo/worktrees/014/.kanban/tasks/014.md');
  const merged = mergeKanbanCards([main, branch]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].inBranch, true);
  assert.equal(branchBadge(merged[0]), 'в ветке');

  const todo = parseKanbanCard(
    CARD.replace('in-progress', 'todo').replace('"014"', '"013"'),
    '/repo/.kanban/tasks/013.md'
  );
  const columns = groupKanbanCards([merged[0], todo]);
  assert.deepEqual(columns.map((column) => column.status), ['todo', 'in-progress']);
  assert.equal(columns[1].cards[0].id, '014');
});

test('рендер-модель webview: колонки и карточки', () => {
  const columns = buildKanbanColumns([
    { id: '2', status: 'todo', title: 'B', owner: '', branch: '', updated: '', path: '/b', inBranch: false },
    { id: '1', status: 'merged', title: 'A', owner: 'o', branch: 'b', updated: 'u', path: '/a', inBranch: true }
  ]);
  assert.deepEqual(columns.map((column) => column.status), ['todo', 'merged']);
  assert.equal(columns[0].label, 'Todo');
  assert.equal(columns[1].cards[0].inBranch, true);
});

test('loadKanbanCards ничего не пишет на диск (read-only)', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-kanban-'));
  const file = path.join(dir, '014.md');
  await writeFile(file, CARD);
  const before = await stat(file);
  const cards = await loadKanbanCards(
    async () => [file],
    (filePath) => readFile(filePath, 'utf8')
  );
  const after = await stat(file);
  assert.equal(cards.length, 1);
  assert.equal(cards[0].id, '014');
  assert.equal(before.mtimeMs, after.mtimeMs);
  assert.equal(await readFile(file, 'utf8'), CARD);
});

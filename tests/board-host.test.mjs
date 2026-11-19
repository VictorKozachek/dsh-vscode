import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

/** Проверка, что доска смонтирована в webview, а не лежит мёртвым кодом. */
test('App монтирует Board и обрабатывает boardOpen/действия', async () => {
  const source = await readFile(
    new URL('../webview/src/App.tsx', import.meta.url),
    'utf8'
  );
  assert.match(source, /import \{ Board \} from '\.\/board\/Board'/);
  assert.match(source, /case 'boardOpen'/);
  assert.match(source, /setBoardData\(message\.data/);
  assert.match(source, /<Board/);
  for (const kind of ['boardRefresh', 'boardInstall', 'boardCreate', 'boardOpenCard']) {
    assert.match(source, new RegExp(`type: '${kind}'`), `действие ${kind}`);
  }
  assert.match(source, /onOpenCard=/, 'клик по карточке');
  assert.match(source, /Закрыть доску/, 'закрытие доски');
});

test('Board показывает статус плагина, установку и встроенный режим', async () => {
  const source = await readFile(
    new URL('../webview/src/board/Board.tsx', import.meta.url),
    'utf8'
  );
  assert.match(source, /плагин DSH активен/);
  assert.match(source, /плагин не установлен/);
  assert.match(source, /onInstall/);
  assert.match(source, /Работать со встроенной доской/);
  assert.match(source, /onCreateBoard/);
  assert.match(source, /createBoard|нет `\.kanban\/tasks`/);
});

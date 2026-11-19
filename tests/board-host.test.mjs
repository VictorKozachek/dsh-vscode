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

test('баннер плагина живёт в App (до перезагрузки) и закрытие шлёт boardClose', async () => {
  const app = await readFile(new URL('../webview/src/App.tsx', import.meta.url), 'utf8');
  assert.match(app, /boardPluginHidden/);
  assert.match(app, /pluginBannerHidden=\{boardPluginHidden\}/);
  assert.match(app, /onHidePlugin=/, 'скрытие поднято в App');
  assert.match(app, /type: 'boardClose'/, 'закрытие сообщает host');

  const extension = await readFile(new URL('../extension/src/extension.ts', import.meta.url), 'utf8');
  assert.match(extension, /boardVisible = true/);
  assert.match(extension, /boardVisible = false/);
  assert.match(extension, /if \(boardVisible && lastBoardData/, 'watcher не открывает закрытую доску');
  const focusAt = extension.indexOf("ChatViewProvider.viewType}.focus");
  const postAt = extension.indexOf('await postKanbanBoard();');
  assert.ok(focusAt !== -1 && postAt !== -1 && focusAt < postAt, 'фокус до boardOpen');
});

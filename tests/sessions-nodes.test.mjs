import assert from 'node:assert/strict';
import test from 'node:test';

import { buildSessionsNodes } from '../extension/src/views/sessionsNodes.ts';

test('узлы: загрузка, пусто, ошибка с подсказкой и «Повторить»', () => {
  assert.deepEqual(buildSessionsNodes({ kind: 'loading', groups: [] }), [
    { kind: 'message', label: 'Загрузка сессий…', themeIcon: 'loading~spin' }
  ]);
  assert.deepEqual(buildSessionsNodes({ kind: 'empty', groups: [] }), []);

  const [error] = buildSessionsNodes({
    kind: 'error',
    groups: [],
    error: { message: 'spawn ENOENT', canRetry: true, settingsHint: 'Проверьте dsh.executablePath' }
  });
  assert.equal(error.kind, 'message');
  assert.equal(error.label, 'Ошибка: spawn ENOENT');
  assert.equal(error.description, 'Проверьте dsh.executablePath');
  assert.match(error.tooltip, /executablePath/);
  assert.deepEqual(error.command, { command: 'dsh.sessions.refresh', title: 'Повторить' });

  const settings = buildSessionsNodes({
    kind: 'error',
    groups: [],
    error: { message: 'spawn ENOENT', canRetry: true, settingsHint: 'Проверьте dsh.executablePath' }
  })[1];
  assert.equal(settings.label, 'Открыть настройки DSH');
  assert.deepEqual(settings.command, { command: 'dsh.openSettings', title: 'Настройки DSH' });
});

test('узлы: ready отдаёт группы, активная уже первая', () => {
  const groups = [
    {
      key: 'today',
      label: 'Сегодня',
      items: [
        {
          id: 's1',
          label: 'Сессия',
          description: 'активна',
          tooltip: '',
          badge: 'active',
          contextValue: 'dshSession.active',
          updatedAt: '',
          workspaceId: 'w'
        }
      ]
    }
  ];
  const nodes = buildSessionsNodes({ kind: 'ready', groups, activeSessionId: 's1' });
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].kind, 'group');
  assert.equal(nodes[0].group.items[0].contextValue, 'dshSession.active');
});

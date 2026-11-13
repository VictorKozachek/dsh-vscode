import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildSessionsView,
  bucketOf,
  GROUP_LABELS,
  sessionLabel,
  SessionRefreshLoop,
  SETTINGS_HINT
} from '../extension/src/views/sessionsModel.ts';

const NOW = new Date('2026-11-13T18:00:00.000Z');

function snapshot(overrides = {}) {
  return {
    workspaceId: 'ws-1',
    sessionId: null,
    title: null,
    status: 'active',
    turnId: null,
    updatedAt: `2026-11-13T12:00:00.000Z`,
    ...overrides
  };
}

function session(id, updatedAt, overrides = {}) {
  return { id, workspaceId: 'ws-1', updatedAt, ...overrides };
}

test('группировка по дате и сортировка внутри группы', () => {
  const view = buildSessionsView({
    now: NOW,
    snapshot: snapshot({ sessionId: 'sess-today-old' }),
    sessions: [
      session('sess-old', '2026-10-01T10:00:00.000Z'),
      session('sess-yesterday', '2026-11-12T20:00:00.000Z'),
      session('sess-today-old', '2026-11-13T09:00:00.000Z'),
      session('sess-today-new', '2026-11-13T17:00:00.000Z')
    ]
  });

  assert.equal(view.kind, 'ready');
  assert.deepEqual(
    view.groups.map((group) => [group.key, group.items.map((item) => item.id)]),
    [
      ['today', ['sess-today-old', 'sess-today-new']],
      ['yesterday', ['sess-yesterday']],
      ['earlier', ['sess-old']]
    ]
  );
  assert.equal(view.groups[0].label, GROUP_LABELS.today);
  assert.equal(view.activeSessionId, 'sess-today-old');
  assert.equal(view.groups[0].items[0].badge, 'active', 'активная сессия первая');
  assert.equal(view.groups[0].items[0].contextValue, 'dshSession.active');
  assert.equal(view.groups[0].items[1].badge, 'idle');
});

test('бакеты дат: сегодня/вчера/ранее и битая дата', () => {
  // Даты локальные: группировка идёт по локальному дню пользователя.
  const local = (y, m, d, h, min) => new Date(y, m - 1, d, h, min).toISOString();
  const now = new Date(2026, 10, 13, 18, 0);
  assert.equal(bucketOf(local(2026, 11, 13, 10, 0), now), 'today');
  assert.equal(bucketOf(local(2026, 11, 12, 23, 59), now), 'yesterday');
  assert.equal(bucketOf(local(2026, 11, 1, 10, 0), now), 'earlier');
  assert.equal(bucketOf('не дата', now), 'earlier');
});

test('заголовок: title или короткий id, tooltip с деталями', () => {
  assert.equal(sessionLabel(session('abcdef1234567890')), 'Сессия abcdef12');
  assert.equal(sessionLabel(session('x', '2026-11-13T10:00:00.000Z', { title: '  Мой чат ' })), 'Мой чат');

  const view = buildSessionsView({
    now: NOW,
    snapshot: snapshot({ sessionId: 's' }),
    sessions: [session('s', '2026-11-13T10:00:00.000Z', { title: 'Сессия дня' })]
  });
  assert.equal(view.kind, 'ready');
  const item = view.groups[0].items[0];
  assert.equal(item.label, 'Сессия дня');
  assert.match(item.tooltip, /id: s/);
  assert.match(item.tooltip, /клик: уже активна/);
});

test('состояния: загрузка, пусто, ошибка', () => {
  assert.equal(
    buildSessionsView({ now: NOW, snapshot: snapshot({ status: 'restoring' }), sessions: [], loading: true }).kind,
    'loading'
  );
  assert.equal(buildSessionsView({ now: NOW, snapshot: snapshot(), sessions: [] }).kind, 'empty');

  const error = buildSessionsView({
    now: NOW,
    snapshot: snapshot({ status: 'offline' }),
    sessions: [],
    error: 'spawn ENOENT'
  });
  assert.equal(error.kind, 'error');
  assert.deepEqual(error.error, {
    message: 'spawn ENOENT',
    canRetry: true,
    settingsHint: SETTINGS_HINT
  });

  const offline = buildSessionsView({
    now: NOW,
    snapshot: snapshot({ status: 'offline' }),
    sessions: [session('s', '2026-11-13T10:00:00.000Z')]
  });
  assert.equal(offline.kind, 'error', 'остановленный рантайм не роняет панель');
});

test('SessionRefreshLoop: опрос только пока видимо, reset переставляет таймер', () => {
  const tasks = [];
  let refreshes = 0;
  const loop = new SessionRefreshLoop({
    refresh: () => {
      refreshes += 1;
    },
    intervalMs: 5000,
    schedule: (callback, delayMs) => {
      const task = { callback, delayMs, cancelled: false };
      tasks.push(task);
      return task;
    },
    cancel: (task) => {
      task.cancelled = true;
    }
  });

  const pending = () => tasks.filter((task) => !task.cancelled);

  loop.start();
  assert.equal(pending().length, 1);
  assert.equal(pending()[0].delayMs, 5000);

  loop.reset();
  assert.equal(pending().length, 1, 'старый таймер отменён, новый поставлен');

  const task = pending()[0];
  task.cancelled = true;
  task.callback();
  assert.equal(refreshes, 1);
  assert.equal(pending().length, 1, 'после срабатывания опрос продолжается');

  loop.stop();
  assert.equal(pending().length, 0);
  assert.equal(loop.running, false);
});

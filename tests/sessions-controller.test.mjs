import assert from 'node:assert/strict';
import { register } from 'node:module';
import test from 'node:test';

// sessionsController.ts импортирует соседний модуль без расширения.
register('./helpers/ts-loader.mjs', import.meta.url);
const { SessionsController } = await import('../extension/src/views/sessionsController.ts');

const flush = () => new Promise((resolve) => setImmediate(resolve));

function createScheduler() {
  const tasks = [];
  return {
    schedule(callback, delayMs) {
      const task = { callback, delayMs, cancelled: false };
      tasks.push(task);
      return task;
    },
    cancel(task) {
      task.cancelled = true;
    },
    pending() {
      return tasks.filter((task) => !task.cancelled);
    }
  };
}

function session(id, updatedAt = '2026-11-13T10:00:00.000Z', title) {
  return { id, workspaceId: 'ws-1', updatedAt, ...(title === undefined ? {} : { title }) };
}

function createSource({ sessions = [], error = null } = {}) {
  const calls = [];
  const listeners = new Map();
  let listError = error;
  const source = {
    snapshot: {
      workspaceId: 'ws-1',
      sessionId: null,
      title: null,
      status: 'active',
      turnId: null,
      updatedAt: '2026-11-13T10:00:00.000Z'
    },
    get state() {
      return this.snapshot;
    },
    async list() {
      calls.push(['list']);
      if (listError !== null) {
        throw new Error(listError);
      }
      return sessions;
    },
    on(event, listener) {
      const set = listeners.get(event) ?? new Set();
      set.add(listener);
      listeners.set(event, set);
      return {
        dispose() {
          set.delete(listener);
        }
      };
    },
    emit(event) {
      for (const listener of listeners.get(event) ?? []) {
        listener(this.snapshot);
      }
    },
    listenerCount() {
      return [...listeners.values()].reduce((total, set) => total + set.size, 0);
    },
    async resume(sessionId) {
      calls.push(['resume', sessionId]);
      this.snapshot = { ...this.snapshot, sessionId, status: 'active' };
      return this.snapshot;
    },
    async create() {
      calls.push(['create']);
      const created = session('sess-new');
      sessions.push(created);
      this.snapshot = { ...this.snapshot, sessionId: created.id, status: 'active' };
      return this.snapshot;
    },
    async pause() {
      calls.push(['pause']);
      this.snapshot = { ...this.snapshot, status: 'paused' };
      return this.snapshot;
    },
    setListError(message) {
      listError = message;
    }
  };
  Object.defineProperty(source, 'calls', { value: calls });
  return { source, calls, scheduler: null };
}

function createController(source, extra = {}) {
  const states = [];
  const scheduler = createScheduler();
  const controller = new SessionsController({
    source,
    view: {
      render(state) {
        states.push(state);
      }
    },
    pollIntervalMs: 5000,
    schedule: scheduler.schedule,
    cancel: scheduler.cancel,
    now: () => new Date('2026-11-13T18:00:00.000Z'),
    ...extra
  });
  return { controller, states, scheduler };
}

test('start: загрузка, затем готовый список и опрос', async () => {
  const { source } = createSource({ sessions: [session('sess-1', '2026-11-13T10:00:00.000Z', 'Первая')] });
  const { controller, states, scheduler } = createController(source);

  controller.start();
  assert.equal(states.at(-1)?.kind, 'loading');
  await flush();
  assert.equal(states.at(-1)?.kind, 'ready');
  assert.equal(states.at(-1).groups[0].items[0].label, 'Первая');
  assert.equal(scheduler.pending().length, 1, 'fallback-опрос 5 с');

  controller.dispose();
  assert.equal(source.listenerCount(), 0);
});

test('пустое состояние и ошибка с retry', async () => {
  const empty = createSource({ sessions: [] });
  const first = createController(empty.source);
  first.controller.start();
  await flush();
  assert.equal(first.states.at(-1)?.kind, 'empty');

  const broken = createSource({ sessions: [], error: 'spawn ENOENT' });
  const second = createController(broken.source);
  second.controller.start();
  await flush();
  const state = second.states.at(-1);
  assert.equal(state.kind, 'error');
  assert.equal(state.error.message, 'spawn ENOENT');
  assert.equal(state.error.canRetry, true);
  assert.match(state.error.settingsHint, /dsh\.executablePath/);

  broken.source.setListError(null);
  await second.controller.refresh();
  assert.equal(second.states.at(-1)?.kind, 'empty', 'повтор после ошибки работает');
});

test('клик по сессии делает её активной, повторный клик — no-op', async () => {
  const { source, calls } = createSource({ sessions: [session('sess-1'), session('sess-2')] });
  const { controller, states } = createController(source);
  await controller.refresh();

  await controller.select('sess-2');
  assert.deepEqual(calls.filter(([name]) => name === 'resume'), [['resume', 'sess-2']]);
  const ready = states.at(-1);
  assert.equal(ready.kind, 'ready');
  assert.equal(ready.activeSessionId, 'sess-2');
  const activeItem = ready.groups[0].items.find((item) => item.id === 'sess-2');
  assert.equal(activeItem.badge, 'active');

  await controller.select('sess-2');
  assert.equal(calls.filter(([name]) => name === 'resume').length, 1, 'повторный клик не дёргает resume');
  controller.dispose();
});

test('create и stopSession ходят через SessionManager (без прямого HTTP)', async () => {
  const { source, calls } = createSource({ sessions: [] });
  const { controller } = createController(source);
  await controller.refresh();

  const created = await controller.create();
  assert.equal(created.sessionId, 'sess-new');
  assert.deepEqual(calls.filter(([name]) => name === 'create'), [['create']]);

  await controller.stopSession();
  assert.ok(calls.some(([name]) => name === 'pause'));
  controller.dispose();
});

test('Rename/Delete/Open Transcript: без поддержки рантайма — false', async () => {
  const { source } = createSource({ sessions: [session('sess-1')] });
  const { controller } = createController(source);
  await controller.refresh();

  assert.equal(await controller.rename('sess-1', 'Новое имя'), false);
  assert.equal(await controller.remove('sess-1'), false);
  assert.equal(await controller.openTranscript('sess-1'), false);
  controller.dispose();
});

test('Rename/Delete/Open Transcript с поддержкой рантайма', async () => {
  const renamed = [];
  const removed = [];
  const { source } = createSource({ sessions: [session('sess-1')] });
  source.rename = async (id, title) => {
    renamed.push([id, title]);
  };
  source.remove = async (id) => {
    removed.push(id);
  };
  source.openTranscript = async (id) => id === 'sess-1';

  const { controller } = createController(source);
  await controller.refresh();
  assert.equal(await controller.rename('sess-1', 'Новое имя'), true);
  assert.deepEqual(renamed, [['sess-1', 'Новое имя']]);
  assert.equal(await controller.remove('sess-1'), true);
  assert.deepEqual(removed, ['sess-1']);
  assert.equal(await controller.openTranscript('sess-1'), true);
  controller.dispose();
});

test('события рантайма обновляют список и сбрасывают таймер опроса', async () => {
  const { source } = createSource({ sessions: [session('sess-1')] });
  const { controller, scheduler, states } = createController(source);
  controller.start();
  await flush();
  const before = states.filter((state) => state.kind === 'ready').length;

  source.emit('sessionChanged');
  await flush();
  await flush();
  assert.ok(
    states.filter((state) => state.kind === 'ready').length > before,
    'событие перерисовало панель'
  );
  assert.equal(scheduler.pending().length, 1, 'таймер опроса переставлен, не размножен');
  controller.dispose();
});

test('видимость панели включает/выключает fallback-опрос', async () => {
  const { source } = createSource({ sessions: [session('sess-1')] });
  const { controller, scheduler } = createController(source);

  controller.setVisible(true);
  await flush();
  assert.equal(scheduler.pending().length, 1);

  controller.setVisible(false);
  assert.equal(scheduler.pending().length, 0);

  controller.setVisible(true);
  await flush();
  assert.equal(scheduler.pending().length, 1);
  controller.dispose();
});

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  WorkspaceLifecycle,
  graceMsFromMinutes
} from '../extension/src/workspace/lifecycle.ts';

const flush = () => new Promise((resolve) => setImmediate(resolve));

/** Fake timers: задачи запускаются вручную, отменённые не выполняются. */
function createScheduler() {
  const tasks = [];
  return {
    schedule(callback, delayMs) {
      const task = { callback, delayMs, cancelled: false };
      tasks.push(task);
      return task;
    },
    cancel(handle) {
      handle.cancelled = true;
    },
    pending() {
      return tasks.filter((task) => !task.cancelled);
    },
    runNext() {
      const task = tasks.find((item) => !item.cancelled);
      if (task === undefined) {
        return false;
      }
      task.cancelled = true;
      task.callback();
      return true;
    },
    runAll() {
      let ran = false;
      while (this.runNext()) {
        ran = true;
      }
      return ran;
    }
  };
}

function createHarness({ graceMs = 60_000, debounceMs = 0 } = {}) {
  const scheduler = createScheduler();
  const calls = [];
  const runtimes = new Map();

  const createRuntime = async (folder) => {
    calls.push(['create', folder.id]);
    const runtime = {
      workspaceId: folder.id,
      workspacePath: folder.path,
      async loadContext() {
        calls.push(['loadContext', folder.id]);
      },
      async restoreSession() {
        calls.push(['restoreSession', folder.id]);
      },
      async pause() {
        calls.push(['pause', folder.id]);
      },
      async resume() {
        calls.push(['resume', folder.id]);
      },
      async dispose() {
        calls.push(['dispose', folder.id]);
      }
    };
    runtimes.set(folder.id, runtime);
    return runtime;
  };

  const states = [];
  const activeChanges = [];
  const lifecycle = new WorkspaceLifecycle({
    createRuntime,
    graceMs,
    debounceMs,
    schedule: scheduler.schedule,
    cancel: scheduler.cancel,
    onStateChanged: (state, active) => states.push([state, active]),
    onActiveChanged: (id) => activeChanges.push(id)
  });

  return { lifecycle, scheduler, calls, states, activeChanges, count: (name, id) => calls.filter(([n, i]) => n === name && i === id).length };
}

const A = { id: 'aaaa', path: '/repo/a' };
const B = { id: 'bbbb', path: '/repo/b' };

test('A → B → A: активный воркспейс и сессия меняются, процессы живы', async () => {
  const { lifecycle, calls, count } = createHarness();
  await lifecycle.activate(A);
  assert.equal(lifecycle.state, 'ready');
  assert.equal(lifecycle.activeWorkspaceId, 'aaaa');
  assert.equal(count('loadContext', 'aaaa'), 1);
  assert.equal(count('restoreSession', 'aaaa'), 1);

  await lifecycle.activate(B);
  assert.equal(lifecycle.activeWorkspaceId, 'bbbb');
  assert.deepEqual(lifecycle.retainedWorkspaceIds, ['aaaa']);
  assert.equal(count('pause', 'aaaa'), 1);
  assert.equal(count('dispose', 'aaaa'), 0, 'процесс A жив на grace period');

  await lifecycle.activate(A);
  assert.equal(lifecycle.activeWorkspaceId, 'aaaa');
  assert.equal(count('create', 'aaaa'), 1, 'A не пересоздаётся');
  assert.equal(count('resume', 'aaaa'), 1, 'быстрый возврат — resume');
  assert.deepEqual(lifecycle.retainedWorkspaceIds, ['bbbb']);
  assert.equal(lifecycle.state, 'ready');
  assert.ok(calls.some(([name, id]) => name === 'create' && id === 'bbbb'));
});

test('teardown по таймеру grace period освобождает процесс', async () => {
  const { lifecycle, scheduler, count } = createHarness({ graceMs: 10_000 });
  await lifecycle.activate(A);
  await lifecycle.deactivate();

  assert.equal(lifecycle.state, 'paused');
  assert.equal(count('dispose', 'aaaa'), 0);

  scheduler.runAll();
  await flush();
  await flush();

  assert.equal(count('dispose', 'aaaa'), 1);
  assert.equal(lifecycle.state, 'teardown');
  assert.deepEqual(lifecycle.retainedWorkspaceIds, []);
});

test('возврат в пределах grace не перезапускает процесс', async () => {
  const { lifecycle, scheduler, count } = createHarness({ graceMs: 10_000 });
  await lifecycle.activate(A);
  await lifecycle.deactivate();
  const pendingBefore = scheduler.pending().length;
  assert.equal(pendingBefore, 1);

  await lifecycle.activate(A);
  assert.equal(count('create', 'aaaa'), 1);
  assert.equal(count('resume', 'aaaa'), 1);
  assert.equal(scheduler.pending().length, 0, 'таймер grace отменён');
  assert.equal(lifecycle.state, 'ready');
});

test('debounce смены папок: одна активация на серию событий', async () => {
  const { lifecycle, scheduler, count } = createHarness({ debounceMs: 50 });
  await lifecycle.activate(A);

  lifecycle.handleWorkspaceFolders([B]);
  lifecycle.handleWorkspaceFolders([{ id: 'bbbb', path: '/repo/b' }]);
  assert.equal(count('create', 'bbbb'), 0, 'до debounce ничего не создаётся');

  assert.equal(scheduler.pending().length, 1, 'предыдущий таймер отменён');
  scheduler.runAll();
  await flush();
  await flush();

  assert.equal(lifecycle.activeWorkspaceId, 'bbbb');
  assert.equal(count('create', 'bbbb'), 1);
});

test('пустой список папок деактивирует воркспейс', async () => {
  const { lifecycle, scheduler } = createHarness({ debounceMs: 0 });
  await lifecycle.activate(A);

  lifecycle.handleWorkspaceFolders([]);
  scheduler.runAll();
  await flush();
  await flush();

  assert.equal(lifecycle.activeWorkspaceId, null);
  assert.equal(lifecycle.state, 'paused');
  assert.deepEqual(lifecycle.retainedWorkspaceIds, ['aaaa']);
});

test('события старого воркспейса отбрасываются по id', async () => {
  const { lifecycle } = createHarness();
  await lifecycle.activate(A);
  assert.equal(lifecycle.acceptsEvent('aaaa'), true);

  await lifecycle.activate(B);
  assert.equal(lifecycle.acceptsEvent('aaaa'), false, 'событие A после переключения');
  assert.equal(lifecycle.acceptsEvent('bbbb'), true);

  await lifecycle.activate(A);
  assert.equal(lifecycle.acceptsEvent('bbbb'), false);
  assert.equal(lifecycle.acceptsEvent('aaaa'), true);
});

test('ошибка создания рантайма не оставляет воркспейс активным', async () => {
  const lifecycle = new WorkspaceLifecycle({
    createRuntime: async () => {
      throw new Error('spawn failed');
    }
  });
  await assert.rejects(() => lifecycle.activate(A), /spawn failed/);
  assert.equal(lifecycle.activeWorkspaceId, null);
  assert.notEqual(lifecycle.state, 'ready');
});

test('teardownAll останавливает активный и удержанные процессы', async () => {
  const { lifecycle, count } = createHarness();
  await lifecycle.activate(A);
  await lifecycle.activate(B);
  await lifecycle.teardownAll();

  assert.equal(count('dispose', 'aaaa'), 1);
  assert.equal(count('dispose', 'bbbb'), 1);
  assert.equal(lifecycle.state, 'teardown');
  assert.equal(lifecycle.activeWorkspaceId, null);
});

test('состояния и активный воркспейс сообщаются наружу по порядку', async () => {
  const { lifecycle, states, activeChanges } = createHarness();
  await lifecycle.activate(A);

  const names = states.map(([state]) => state);
  assert.deepEqual(names.slice(0, 3), ['resolving', 'loading-context', 'ready']);
  assert.deepEqual(activeChanges, ['aaaa']);
  assert.equal(lifecycle.state, 'ready');
});

test('graceMsFromMinutes: настройка → мс, мусор → 10 минут', () => {
  assert.equal(graceMsFromMinutes(10), 600_000);
  assert.equal(graceMsFromMinutes(0), 0);
  assert.equal(graceMsFromMinutes('5'), 300_000);
  assert.equal(graceMsFromMinutes(undefined), 600_000);
  assert.equal(graceMsFromMinutes('abc'), 600_000);
  assert.equal(graceMsFromMinutes(-5), 600_000);
  assert.equal(graceMsFromMinutes(2.5), 150_000);
});

test('папка убрана до готовности активации: [] не теряется', async () => {
  let resolveCreate;
  const created = new Promise((resolve) => {
    resolveCreate = resolve;
  });
  const runtime = {
    workspaceId: 'aaaaaaaaaaaaaaaa',
    workspacePath: '/repo/a',
    async loadContext() {},
    async restoreSession() {},
    async pause() {},
    async resume() {},
    async dispose() {}
  };
  const lifecycle = new WorkspaceLifecycle({
    createRuntime: async () => {
      await created;
      return runtime;
    },
    graceMs: 60_000,
    debounceMs: 0,
    schedule: (callback) => {
      queueMicrotask(callback);
      return {};
    },
    cancel: () => undefined
  });

  lifecycle.handleWorkspaceFolders([{ id: 'aaaaaaaaaaaaaaaa', path: '/repo/a' }]);
  await flush();
  // Активация висит в createRuntime; папку убрали до ready.
  lifecycle.handleWorkspaceFolders([]);
  await flush();
  resolveCreate();
  await flush();
  await flush();

  assert.equal(lifecycle.activeWorkspaceId, null, 'A не должна стать активной');
  assert.notEqual(lifecycle.state, 'ready');
  await lifecycle.teardownAll();
});

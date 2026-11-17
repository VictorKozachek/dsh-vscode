import assert from 'node:assert/strict';
import { register } from 'node:module';
import test from 'node:test';

register('./helpers/ts-loader.mjs', import.meta.url);
const { SessionManagerSource } = await import('../extension/src/views/sessionsSource.ts');
const { SessionsController } = await import('../extension/src/views/sessionsController.ts');

const snapshot = (sessionId = null) => ({
  workspaceId: 'ws',
  sessionId,
  title: null,
  status: 'active',
  turnId: null,
  updatedAt: '2026-11-13T10:00:00.000Z'
});

function createManager(sessions = []) {
  const listeners = new Map();
  return {
    state: snapshot(),
    calls: [],
    async list() {
      return sessions;
    },
    async resume(id) {
      this.calls.push(['resume', id]);
      this.state = snapshot(id);
      return this.state;
    },
    async create(options = {}) {
      this.calls.push(['create', options]);
      return snapshot('sess-created');
    },
    async pause() {
      this.calls.push(['pause']);
      return this.state;
    },
    on(event, listener) {
      listeners.set(event, listener);
      return { dispose: () => listeners.delete(event) };
    },
    emit(event) {
      listeners.get(event)?.(this.state);
    },
    listenerCount() {
      return listeners.size;
    }
  };
}

test('менеджер появляется позже: подписки подключаются, список загружается', async () => {
  let manager = null;
  const source = new SessionManagerSource(() => manager);
  const states = [];
  const controller = new SessionsController({
    source,
    view: { render: (state) => states.push(state) },
    schedule: () => ({}),
    cancel: () => undefined
  });
  controller.start();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(states.at(-1).kind, 'error', 'до менеджера — ошибка');

  manager = createManager([{ id: 's1', workspaceId: 'ws', updatedAt: '2026-11-13T10:00:00.000Z' }]);
  source.refreshManager();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(states.at(-1).kind, 'ready', 'после появления менеджера — список');
  assert.equal(manager.listenerCount(), 2, 'подписки подключены к новому менеджеру');

  manager.emit('sessionChanged');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(states.at(-1).kind, 'ready');
  controller.dispose();
});

test('create передаёт заголовок в менеджер; resume клик работает через источник', async () => {
  const manager = createManager([]);
  const source = new SessionManagerSource(() => manager);
  const states = [];
  const controller = new SessionsController({
    source,
    view: { render: (state) => states.push(state) },
    schedule: () => ({}),
    cancel: () => undefined
  });
  await controller.refresh();
  await controller.create('Мой чат');
  assert.deepEqual(manager.calls[0], ['create', { title: 'Мой чат' }]);
  await controller.select('s1');
  assert.deepEqual(manager.calls[1], ['resume', 's1']);
  controller.dispose();
});

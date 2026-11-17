import assert from 'node:assert/strict';
import { register } from 'node:module';
import test from 'node:test';

register('./helpers/ts-loader.mjs', import.meta.url);
const { SessionManager } = await import('../extension/src/sessions/sessionManager.ts');
const { SessionManagerSource } = await import('../extension/src/views/sessionsSource.ts');
const { SessionsController } = await import('../extension/src/views/sessionsController.ts');

const SUMMARY = {
  id: 'sess-existing',
  workspaceId: 'ws',
  title: 'Старая сессия',
  updatedAt: '2026-11-13T10:00:00.000Z'
};

function createBridge() {
  const calls = [];
  const listeners = new Map();
  let sessions = [SUMMARY];
  return {
    calls,
    async start() {},
    async stop() {},
    async request(method, params) {
      calls.push({ method, params });
      switch (method) {
        case 'session.list':
          return { sessions };
        case 'session.create':
          sessions = [
            ...sessions,
            { id: 'sess-created', workspaceId: 'ws', title: params.title ?? null, updatedAt: '2026-11-13T11:00:00.000Z' }
          ];
          return { sessionId: 'sess-created', createdAt: '2026-11-13T11:00:00.000Z' };
        case 'session.resume':
          return {
            session: { id: params.sessionId, workspaceId: 'ws', title: 'Возобновлена', updatedAt: '2026-11-13T10:00:00.000Z' }
          };
        case 'turn.cancel':
          return { cancelled: true };
        default:
          throw new Error(`нет обработчика ${method}`);
      }
    },
    on(event, listener) {
      listeners.set(event, listener);
      return { dispose: () => listeners.delete(event) };
    },
    emit(event, payload) {
      listeners.get(event)?.(payload);
    }
  };
}

function createController(bridge) {
  const manager = new SessionManager({ workspaceId: 'ws', bridge });
  const source = new SessionManagerSource(() => manager);
  const states = [];
  const controller = new SessionsController({
    source,
    view: { render: (state) => states.push(state) },
    schedule: () => ({}),
    cancel: () => undefined
  });
  return { manager, source, controller, states };
}

test('SessionsController + SessionManager + fake DshBridge: список, клик, создание', async () => {
  const bridge = createBridge();
  const { controller, states } = createController(bridge);
  controller.start();
  await new Promise((resolve) => setImmediate(resolve));

  const ready = states.at(-1);
  assert.equal(ready.kind, 'ready');
  assert.equal(ready.groups[0].items[0].label, 'Старая сессия');

  await controller.select('sess-existing');
  assert.deepEqual(
    bridge.calls.find((call) => call.method === 'session.resume').params,
    { sessionId: 'sess-existing' }
  );

  await controller.create('Новая из панели');
  const createCall = bridge.calls.find((call) => call.method === 'session.create');
  assert.equal(createCall.params.title, 'Новая из панели');
  assert.equal(createCall.params.workspaceId, 'ws');

  await controller.refresh();
  const list = states.at(-1);
  assert.equal(list.kind, 'ready');
  const labels = list.groups.flatMap((group) => group.items.map((item) => item.label));
  assert.ok(labels.includes('Новая из панели'));
  controller.dispose();
});

test('активная сессия из снимка попадает в список, даже если list её не отдаёт', async () => {
  const bridge = createBridge();
  const { controller, states, manager } = createController(bridge);
  await manager.resume('sess-existing'); // активная есть в снимке, list её содержит
  await controller.refresh();
  const ready = states.at(-1);
  const active = ready.groups.flatMap((group) => group.items).find((item) => item.badge === 'active');
  assert.ok(active, 'активная отрисована');
  assert.equal(active.id, 'sess-existing');
  controller.dispose();
});

test('ACP-like пустой session.list: активная после resume всё равно отрисована', async () => {
  const bridge = createBridge();
  bridge.request = async (method, params) => {
    bridge.calls.push({ method, params });
    if (method === 'session.list') {
      return { sessions: [] }; // ACP: активная появляется только после close
    }
    if (method === 'session.resume') {
      return { session: { id: params.sessionId, workspaceId: 'ws', title: 'Скрытая', updatedAt: '2026-11-13T10:00:00.000Z' } };
    }
    throw new Error(`нет обработчика ${method}`);
  };
  const { controller, states, manager } = createController(bridge);
  await manager.resume('hidden-active');
  await controller.refresh();
  const ready = states.at(-1);
  assert.equal(ready.kind, 'ready');
  const active = ready.groups.flatMap((group) => group.items).find((item) => item.badge === 'active');
  assert.equal(active.id, 'hidden-active');
  controller.dispose();
});

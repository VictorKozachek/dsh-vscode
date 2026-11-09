import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SessionManager,
  SessionManagerError,
  createSessionCommands
} from '../extension/src/sessions/sessionManager.ts';
import { createRegistrySessionPersistence } from '../extension/src/sessions/registryPersistence.ts';

/** Мост-заглушка с обработчиками методов и эмиттером событий. */
function createBridge(handlers = {}) {
  const calls = [];
  const listeners = new Map();
  return {
    calls,
    async start() {
      calls.push({ method: 'start' });
      if (handlers.startError !== undefined) {
        throw handlers.startError;
      }
    },
    async stop() {
      calls.push({ method: 'stop' });
    },
    async request(method, params) {
      calls.push({ method, params });
      const handler = handlers[method];
      if (handler === undefined) {
        throw new Error(`нет обработчика ${method}`);
      }
      return await handler(params);
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
    emit(event, payload) {
      for (const listener of listeners.get(event) ?? []) {
        listener(payload);
      }
    },
    listenerCount() {
      return [...listeners.values()].reduce((total, set) => total + set.size, 0);
    },
    count(method) {
      return calls.filter((call) => call.method === method).length;
    }
  };
}

/** `workspaceState`-заглушка. */
function createStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    get(key, defaultValue) {
      return map.has(key) ? map.get(key) : defaultValue;
    },
    async update(key, value) {
      map.set(key, value);
    }
  };
}

/** Реестр-заглушка (порт #003). */
function createPersistence(lastSessionId = null) {
  const writes = [];
  return {
    writes,
    last: lastSessionId,
    async readLastSession() {
      return this.last;
    },
    async writeLastSession(workspaceId, sessionId, updatedAt) {
      this.last = sessionId;
      writes.push({ workspaceId, sessionId, updatedAt });
    }
  };
}

const SESSION = { id: 'sess_resumed', workspaceId: 'ws_1', title: 'Старая сессия', updatedAt: '2026-11-09T10:00:00.000Z' };

function createManager({ bridge, storage, persistence, logger = () => undefined } = {}) {
  const manager = new SessionManager({
    workspaceId: 'ws_1',
    bridge,
    storage,
    persistence,
    logger,
    clock: () => new Date('2026-11-09T12:00:00.000Z')
  });
  return manager;
}

test('restore без сохранённой сессии создаёт новую', async () => {
  const bridge = createBridge({
    'session.create': () => ({ sessionId: 'sess_new', createdAt: '2026-11-09T12:00:00.000Z' })
  });
  const storage = createStorage();
  const persistence = createPersistence(null);
  const manager = createManager({ bridge, storage, persistence });

  const snapshot = await manager.restore();

  assert.equal(bridge.count('start'), 1);
  assert.equal(bridge.count('session.create'), 1);
  assert.equal(bridge.count('session.resume'), 0);
  assert.equal(snapshot.sessionId, 'sess_new');
  assert.equal(snapshot.status, 'active');
  assert.equal(persistence.last, 'sess_new');
  assert.equal(storage.get('dsh.session.last.ws_1'), 'sess_new');
  manager.dispose();
});

test('restore возобновляет сохранённую сессию без создания новой', async () => {
  const bridge = createBridge({
    'session.resume': () => ({ session: SESSION })
  });
  const persistence = createPersistence('sess_resumed');
  const manager = createManager({ bridge, persistence });

  const snapshot = await manager.restore();

  assert.equal(bridge.count('session.resume'), 1);
  assert.equal(bridge.count('session.create'), 0);
  assert.equal(snapshot.sessionId, 'sess_resumed');
  assert.equal(snapshot.title, 'Старая сессия');
  assert.equal(snapshot.status, 'active');
  manager.dispose();
});

test('restore: сессия исчезла на стороне DSH — создаётся новая, причина в логе', async () => {
  const logs = [];
  const bridge = createBridge({
    'session.resume': () => {
      throw new Error('session not found');
    },
    'session.create': () => ({ sessionId: 'sess_new', createdAt: '2026-11-09T12:00:00.000Z' })
  });
  const persistence = createPersistence('sess_gone');
  const manager = createManager({ bridge, persistence, logger: (line) => logs.push(line) });

  const snapshot = await manager.restore();

  assert.equal(bridge.count('session.resume'), 1);
  assert.equal(bridge.count('session.create'), 1);
  assert.equal(snapshot.sessionId, 'sess_new');
  assert.ok(logs.some((line) => line.includes('sess_gone') && line.includes('создаю новую')));
  manager.dispose();
});

test('restore не создаёт дублей при параллельных вызовах (гонка)', async () => {
  const bridge = createBridge({
    'session.resume': () => ({ session: SESSION })
  });
  const persistence = createPersistence('sess_resumed');
  const manager = createManager({ bridge, persistence });

  const [first, second] = await Promise.all([manager.restore(), manager.restore()]);

  assert.equal(bridge.count('session.resume'), 1, 'resume вызван один раз');
  assert.equal(bridge.count('session.create'), 0);
  assert.equal(first.sessionId, 'sess_resumed');
  assert.equal(second.sessionId, 'sess_resumed');
  assert.equal(second.status, 'active');
  manager.dispose();
});

test('create всегда создаёт новую сессию, list идёт через мост', async () => {
  const bridge = createBridge({
    'session.create': (params) => ({ sessionId: `sess_${String(params.workspaceId)}`, createdAt: '2026-11-09T12:00:00.000Z' }),
    'session.list': () => ({ sessions: [SESSION] })
  });
  const persistence = createPersistence(null);
  const manager = createManager({ bridge, persistence });

  const snapshot = await manager.create();
  assert.equal(snapshot.sessionId, 'sess_ws_1');
  assert.equal(persistence.last, 'sess_ws_1');

  const sessions = await manager.list();
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0]?.id, 'sess_resumed');
  manager.dispose();
});

test('stop отменяет ход через turn.cancel и оставляет сессию', async () => {
  const bridge = createBridge({
    'session.create': () => ({ sessionId: 'sess_1', createdAt: '2026-11-09T12:00:00.000Z' }),
    'turn.start': () => ({ turnId: 'turn_7', sessionId: 'sess_1' }),
    'turn.cancel': () => ({ cancelled: true })
  });
  const manager = createManager({ bridge, persistence: createPersistence(null) });

  await manager.create();
  const turnId = await manager.startTurn('вопрос');
  assert.equal(turnId, 'turn_7');
  assert.equal(manager.state.turnId, 'turn_7');

  const paused = await manager.stop();

  const cancel = bridge.calls.find((call) => call.method === 'turn.cancel');
  assert.deepEqual(cancel, {
    method: 'turn.cancel',
    params: { sessionId: 'sess_1', turnId: 'turn_7' }
  });
  assert.equal(paused.status, 'paused');
  assert.equal(paused.sessionId, 'sess_1', 'сессия остаётся активной');
  assert.equal(paused.turnId, null);

  await manager.stop();
  assert.equal(bridge.count('turn.cancel'), 1, 'без активного хода cancel не зовётся');
  manager.dispose();
});

test('pause без активного хода не зовёт turn.cancel', async () => {
  const bridge = createBridge({
    'session.create': () => ({ sessionId: 'sess_1', createdAt: '2026-11-09T12:00:00.000Z' })
  });
  const manager = createManager({ bridge, persistence: createPersistence(null) });
  await manager.create();

  const paused = await manager.pause();
  assert.equal(paused.status, 'paused');
  assert.equal(bridge.count('turn.cancel'), 0);
  manager.dispose();
});

test('события sessionChanged/statusChanged и turn.done от моста', async () => {
  const bridge = createBridge({
    'session.create': () => ({ sessionId: 'sess_1', createdAt: '2026-11-09T12:00:00.000Z' }),
    'turn.start': () => ({ turnId: 'turn_1', sessionId: 'sess_1' })
  });
  const manager = createManager({ bridge, persistence: createPersistence(null) });
  const sessionEvents = [];
  const statusEvents = [];
  manager.on('sessionChanged', (snapshot) => sessionEvents.push(snapshot));
  manager.on('statusChanged', (snapshot) => statusEvents.push(snapshot));

  await manager.create();
  await manager.startTurn('привет');
  bridge.emit('turn.done', { sessionId: 'sess_1', turnId: 'turn_1', finishReason: 'stop' });

  assert.ok(sessionEvents.some((snapshot) => snapshot.sessionId === 'sess_1'));
  assert.ok(statusEvents.some((snapshot) => snapshot.status === 'active'));
  assert.equal(manager.state.turnId, null, 'turn.done очищает активный ход');
  manager.dispose();
});

test('черновики composer’а живут в workspaceState', async () => {
  const bridge = createBridge({});
  const storage = createStorage({ 'dsh.draft.ws_1': 'старый черновик' });
  const manager = createManager({ bridge, storage, persistence: createPersistence(null) });

  assert.equal(manager.getDraft(), 'старый черновик');
  await manager.setDraft('новый черновик');
  assert.equal(manager.getDraft(), 'новый черновик');
  assert.equal(storage.map.get('dsh.draft.ws_1'), 'новый черновик');
  manager.dispose();
});

test('restore: мост не поднимается — понятная ошибка и статус offline', async () => {
  const bridge = createBridge({ startError: new Error('spawn ENOENT') });
  const manager = createManager({ bridge, persistence: createPersistence('sess_1') });

  await assert.rejects(() => manager.restore(), SessionManagerError);
  assert.equal(manager.state.status, 'offline');
  manager.dispose();
});

test('dispose снимает подписки на мост', () => {
  const bridge = createBridge({});
  const manager = createManager({ bridge, persistence: createPersistence(null) });
  assert.ok(bridge.listenerCount() > 0);

  manager.dispose();
  assert.equal(bridge.listenerCount(), 0);
});

test('команды сессий: без менеджера сообщают о неподключённом мосте', async () => {
  const messages = [];
  const commands = createSessionCommands({
    getManager: () => null,
    ui: {
      notify: (message) => {
        messages.push(message);
      }
    }
  });

  await commands.newSession();
  await commands.resumeLast();
  await commands.stopAgent();

  assert.equal(messages.length, 3);
  assert.ok(messages.every((message) => message.includes('мост DSH не подключён')));
  assert.match(messages[0], /DSH: New Session/);
});

test('команды сессий: работают через менеджер и показывают id', async () => {
  const bridge = createBridge({
    'session.create': () => ({ sessionId: 'sess_1', createdAt: '2026-11-09T12:00:00.000Z' }),
    'session.resume': () => ({ session: SESSION }),
    'turn.cancel': () => ({ cancelled: true })
  });
  const manager = createManager({ bridge, persistence: createPersistence(null) });
  const messages = [];
  const commands = createSessionCommands({
    getManager: () => manager,
    ui: {
      notify: (message) => {
        messages.push(message);
      }
    }
  });

  await commands.newSession();
  await commands.resumeLast();
  await commands.stopAgent();

  assert.match(messages[0] ?? '', /сессия sess_1 создана/);
  // Сессия уже активна — resumeLast не дёргает мост и не создаёт дублей.
  assert.match(messages[1] ?? '', /сессия sess_1 восстановлена/);
  assert.equal(bridge.count('session.resume'), 0);
  assert.match(messages[2] ?? '', /ход отменён/);
  manager.dispose();
});

test('адаптер реестра: читает и пишет lastSessionId через #003', async () => {
  const remembered = [];
  const registry = {
    async read(workspaceId) {
      return workspaceId === 'ws_1'
        ? { id: 'ws_1', path: '/repo', lastSessionId: 'sess_old' }
        : null;
    },
    async remember(input) {
      remembered.push(input);
    }
  };

  const persistence = createRegistrySessionPersistence({
    registry,
    workspacePath: '/repo'
  });

  assert.equal(await persistence.readLastSession('ws_1'), 'sess_old');
  assert.equal(await persistence.readLastSession('ws_2'), null);

  await persistence.writeLastSession('ws_1', 'sess_new', '2026-11-09T12:00:00.000Z');
  assert.deepEqual(remembered[0], {
    id: 'ws_1',
    path: '/repo',
    lastSessionId: 'sess_new',
    lastOpenedAt: '2026-11-09T12:00:00.000Z'
  });
});

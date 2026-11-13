import assert from 'node:assert/strict';
import { register } from 'node:module';
import test from 'node:test';

register('./helpers/ts-loader.mjs', import.meta.url);
const { ChatController } = await import('../extension/src/views/chatEvents.ts');

/** Мост-заглушка: записывает запросы и умеет эмитить события. */
function createBridge(handlers = {}) {
  const calls = [];
  const listeners = new Map();
  return {
    calls,
    async request(method, params) {
      calls.push({ method, params });
      const handler = handlers[method];
      if (handler === undefined) {
        return { turnId: 'turn-1' };
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
    }
  };
}

/** Порт SessionManager: снимок, черновики, события. */
function createSessions(initial = { sessionId: 'sess-a', title: 'Сессия A', status: 'active' }) {
  let snapshot = initial;
  const drafts = new Map();
  const listeners = new Map();
  return {
    getSnapshot: () => snapshot,
    getDraft: (id) => drafts.get(id) ?? '',
    setDraft: (id, text) => {
      drafts.set(id, text);
    },
    on(event, listener) {
      const set = listeners.get(event) ?? new Set();
      set.add(listener);
      listeners.set(event, set);
      return { dispose: () => set.delete(listener) };
    },
    switchTo(sessionId, title = 'Сессия B') {
      snapshot = { sessionId, title, status: 'active' };
      for (const listener of listeners.get('sessionChanged') ?? []) {
        listener(snapshot);
      }
    },
    setStatus(status) {
      snapshot = { ...snapshot, status };
      for (const listener of listeners.get('statusChanged') ?? []) {
        listener(snapshot);
      }
    }
  };
}

function createController(bridge, sessions) {
  const posts = [];
  const controller = new ChatController({
    bridge,
    getSessionId: () => sessions.getSnapshot().sessionId,
    post: (message) => posts.push(message),
    sessions
  });
  return { controller, posts };
}

test('события неактивной сессии отбрасываются', () => {
  const bridge = createBridge();
  const sessions = createSessions();
  const { controller, posts } = createController(bridge, sessions);

  bridge.emit('token', { sessionId: 'sess-b', turnId: 'turn-b', text: 'чужое' });
  bridge.emit('tool.call', { sessionId: 'sess-b', callId: 'c1', name: 'read_file' });
  bridge.emit('turn.done', { sessionId: 'sess-b', turnId: 'turn-b', finishReason: 'stop' });

  assert.equal(posts.filter((message) => message.type === 'chatToken').length, 0);
  assert.equal(posts.filter((message) => message.type === 'chatToolCall').length, 0);
  assert.equal(posts.filter((message) => message.type === 'chatDone').length, 0);
  controller.dispose();
});

test('переключение сессии: история, черновик и статус заменяются', async () => {
  const bridge = createBridge();
  const sessions = createSessions();
  const { controller, posts } = createController(bridge, sessions);

  await controller.send('вопрос в A');
  bridge.emit('token', { sessionId: 'sess-a', turnId: 'turn-1', text: 'ответ A' });
  bridge.emit('turn.done', { sessionId: 'sess-a', turnId: 'turn-1', finishReason: 'stop' });
  await new Promise((resolve) => setImmediate(resolve));
  posts.length = 0;

  sessions.setDraft('sess-b', 'черновик B');
  sessions.switchTo('sess-b');
  await new Promise((resolve) => setImmediate(resolve));

  const replaced = posts.find((message) => message.type === 'replaceFeed');
  assert.deepEqual(replaced.records, [], 'у B истории нет — чистый лист');
  const sessionMessage = posts.find((message) => message.type === 'chatSession');
  assert.equal(sessionMessage.session.sessionId, 'sess-b');
  assert.equal(sessionMessage.session.title, 'Сессия B');
  assert.equal(sessionMessage.session.historyState, 'empty');
  const draft = posts.find((message) => message.type === 'composerDraft');
  assert.equal(draft.text, 'черновик B');
  assert.equal(controller.boundSessionId, 'sess-b');
  controller.dispose();
});

test('переключение обратно восстанавливает историю сессии', async () => {
  const bridge = createBridge();
  const sessions = createSessions();
  const { controller, posts } = createController(bridge, sessions);

  await controller.send('сообщение A');
  bridge.emit('token', { sessionId: 'sess-a', turnId: 'turn-1', text: 'ответ' });
  bridge.emit('turn.done', { sessionId: 'sess-a', turnId: 'turn-1', finishReason: 'stop' });
  sessions.switchTo('sess-b');
  await new Promise((resolve) => setImmediate(resolve));
  posts.length = 0;

  sessions.switchTo('sess-a', 'Сессия A');
  await new Promise((resolve) => setImmediate(resolve));

  const replaced = posts.find((message) => message.type === 'replaceFeed');
  assert.deepEqual(
    replaced.records
      .filter((record) => record.kind === 'message')
      .map((record) => [record.message.role, record.message.text]),
    [
      ['user', 'сообщение A'],
      ['assistant', 'ответ']
    ]
  );
  const sessionMessage = posts.find((message) => message.type === 'chatSession');
  assert.equal(sessionMessage.session.historyState, 'replayed');
  controller.dispose();
});

test('Стоп отменяет ход только активной сессии', async () => {
  const bridge = createBridge({
    'turn.start': (params) => ({ turnId: `turn-${params.sessionId}`, sessionId: params.sessionId })
  });
  const sessions = createSessions();
  const { controller } = createController(bridge, sessions);

  await controller.send('A');
  await controller.cancel();
  const firstCancel = bridge.calls.find((call) => call.method === 'turn.cancel');
  assert.deepEqual(firstCancel, {
    method: 'turn.cancel',
    params: { sessionId: 'sess-a', turnId: 'turn-sess-a' }
  });

  sessions.switchTo('sess-b');
  await new Promise((resolve) => setImmediate(resolve));
  await controller.send('B');
  await controller.cancel();

  const cancels = bridge.calls.filter((call) => call.method === 'turn.cancel');
  assert.equal(cancels.length, 2);
  assert.deepEqual(cancels[1], {
    method: 'turn.cancel',
    params: { sessionId: 'sess-b', turnId: 'turn-sess-b' }
  });
  controller.dispose();
});

test('черновик сохраняется за активной сессией', () => {
  const bridge = createBridge();
  const sessions = createSessions();
  const { controller } = createController(bridge, sessions);

  controller.setDraft('недописанное');
  assert.equal(sessions.getDraft('sess-a'), 'недописанное');

  sessions.switchTo('sess-b');
  controller.setDraft('для B');
  assert.equal(sessions.getDraft('sess-b'), 'для B');
  assert.equal(sessions.getDraft('sess-a'), 'недописанное');
  controller.dispose();
});

test('начальная привязка: chatSession/composerDraft уходят сразу', () => {
  const bridge = createBridge();
  const sessions = createSessions();
  const { posts } = createController(bridge, sessions);

  const sessionMessage = posts.find((message) => message.type === 'chatSession');
  assert.ok(sessionMessage, 'chatSession отправлен в конструкторе');
  assert.equal(sessionMessage.session.sessionId, 'sess-a');
  assert.equal(sessionMessage.session.historyState, 'empty');
  assert.ok(posts.some((message) => message.type === 'replaceFeed'));
  assert.ok(posts.some((message) => message.type === 'composerDraft'));
});

test('события без sessionId при активной сессии отбрасываются', () => {
  const bridge = createBridge();
  const sessions = createSessions();
  const { controller, posts } = createController(bridge, sessions);
  posts.length = 0;

  bridge.emit('token', { turnId: 'turn-1', text: 'без сессии' });
  bridge.emit('error', { message: 'чужая ошибка' });

  assert.equal(posts.filter((message) => message.type === 'chatToken').length, 0);
  assert.equal(posts.filter((message) => message.type === 'chatStatus').length, 0);
  controller.dispose();
});

test('tool-события попадают в историю и восстанавливаются при переключении', async () => {
  const bridge = createBridge();
  const sessions = createSessions();
  const { controller, posts } = createController(bridge, sessions);

  await controller.send('прочитай файл');
  bridge.emit('tool.call', {
    sessionId: 'sess-a',
    callId: 'call-1',
    name: 'read_file',
    arguments: { path: 'a.ts' }
  });
  bridge.emit('tool.result', { sessionId: 'sess-a', callId: 'call-1', ok: true, result: { bytes: 1 } });
  bridge.emit('turn.done', { sessionId: 'sess-a', turnId: 'turn-1', finishReason: 'stop' });

  sessions.switchTo('sess-b');
  await new Promise((resolve) => setImmediate(resolve));
  posts.length = 0;

  sessions.switchTo('sess-a');
  await new Promise((resolve) => setImmediate(resolve));

  const replaced = posts.find((message) => message.type === 'replaceFeed');
  assert.deepEqual(
    replaced.records.map((record) => record.kind),
    ['message', 'toolCall', 'toolResult'],
    'порядок user → tool.call → tool.result сохранён'
  );
  const sessionMessage = posts.find((message) => message.type === 'chatSession');
  assert.equal(sessionMessage.session.historyState, 'replayed');
  controller.dispose();
});

test('смена сессии во время turn.start не оставляет streaming старой сессии', async () => {
  let resolveStart;
  const bridge = createBridge({
    'turn.start': () =>
      new Promise((resolve) => {
        resolveStart = resolve;
      })
  });
  const sessions = createSessions();
  const { controller, posts } = createController(bridge, sessions);

  const sending = controller.send('вопрос');
  await new Promise((resolve) => setImmediate(resolve));
  sessions.switchTo('sess-b');
  await new Promise((resolve) => setImmediate(resolve));
  const afterSwitch = posts.length;
  resolveStart({ turnId: 'turn-old' });
  await sending;

  const statuses = posts
    .slice(afterSwitch)
    .filter((message) => message.type === 'chatStatus')
    .map((message) => message.status);
  assert.equal(statuses.includes('streaming'), false, 'streaming старой сессии не выставлен');
  controller.dispose();
});

test('«Повторить» переотправляет последний ввод после ошибки', async () => {
  const bridge = createBridge({
    'turn.start': () => ({ turnId: 'turn-1' })
  });
  const sessions = createSessions();
  const { controller, posts } = createController(bridge, sessions);

  await controller.send('вопрос');
  bridge.emit('error', { sessionId: 'sess-a', message: 'обрыв' });
  posts.length = 0;
  controller.retry();
  await new Promise((resolve) => setImmediate(resolve));

  const starts = bridge.calls.filter((call) => call.method === 'turn.start');
  assert.equal(starts.length, 2);
  assert.equal(starts[1].params.input, 'вопрос');
  assert.equal(
    posts.filter((message) => message.type === 'message' && message.message.role === 'user').length,
    0,
    'retry не дублирует user-сообщение'
  );
  controller.dispose();
});

test('без активной сессии события с sessionId отбрасываются', async () => {
  const bridge = createBridge();
  const sessions = createSessions({ sessionId: null, title: null, status: 'idle' });
  const { controller, posts } = createController(bridge, sessions);
  posts.length = 0;

  bridge.emit('token', { sessionId: 'sess-a', turnId: 't', text: 'чужое' });
  bridge.emit('error', { sessionId: 'sess-a', message: 'чужая ошибка' });
  assert.equal(posts.filter((message) => message.type === 'chatToken').length, 0);
  assert.equal(posts.filter((message) => message.type === 'chatStatus').length, 0);
  controller.dispose();
});

test('offline без локальной истории — historyState unavailable', async () => {
  const bridge = createBridge();
  const sessions = createSessions();
  const { controller, posts } = createController(bridge, sessions);
  posts.length = 0;

  sessions.setStatus('offline');
  await new Promise((resolve) => setImmediate(resolve));

  const sessionMessage = posts.filter((message) => message.type === 'chatSession').at(-1);
  assert.equal(sessionMessage.session.historyState, 'unavailable');
  controller.dispose();
});

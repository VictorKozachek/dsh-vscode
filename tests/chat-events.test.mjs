import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ChatController,
  ChatControllerError,
  TokenBatcher
} from '../extension/src/views/chatEvents.ts';

/** Мост-заглушка: записывает вызовы и умеет эмитить события. */
function createBridge({ handlers = {} } = {}) {
  const calls = [];
  const listeners = new Map();
  return {
    calls,
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
    async request(method, params) {
      calls.push({ method, params });
      const handler = handlers[method];
      return handler === undefined ? { turnId: 'turn_1' } : handler(params);
    },
    emit(event, payload) {
      for (const listener of listeners.get(event) ?? []) {
        listener(payload);
      }
    },
    listenerCount() {
      return [...listeners.values()].reduce((total, set) => total + set.size, 0);
    }
  };
}

/** Планировщик с ручным запуском — батчинг токенов детерминирован. */
function createScheduler() {
  const tasks = [];
  return {
    schedule(callback, ms) {
      const task = { callback, ms, cancelled: false };
      tasks.push(task);
      return task;
    },
    cancel(handle) {
      handle.cancelled = true;
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
    pending() {
      return tasks.filter((item) => !item.cancelled).length;
    }
  };
}

function createController({ sessionId = 'sess_1', handlers = {} } = {}) {
  const bridge = createBridge({ handlers });
  const scheduler = createScheduler();
  const posts = [];
  const controller = new ChatController({
    bridge,
    getSessionId: () => sessionId,
    post: (message) => {
      posts.push(message);
    },
    schedule: scheduler.schedule,
    cancel: scheduler.cancel
  });
  return { bridge, scheduler, posts, controller };
}

test('TokenBatcher: копит токены и отдаёт пачкой по таймеру', () => {
  const scheduler = createScheduler();
  const emitted = [];
  const batcher = new TokenBatcher({
    emit: (text) => {
      emitted.push(text);
    },
    schedule: scheduler.schedule,
    cancel: scheduler.cancel
  });

  batcher.push('a');
  batcher.push('b');
  assert.deepEqual(emitted, [], 'до сброса ничего не отправлено');
  assert.equal(batcher.pending, 'ab');

  assert.equal(scheduler.runNext(), true);
  assert.deepEqual(emitted, ['ab']);
  assert.equal(batcher.pending, '');

  batcher.push('c');
  assert.equal(scheduler.pending(), 1, 'новый токен снова планирует сброс');
  batcher.flush();
  assert.deepEqual(emitted, ['ab', 'c']);
  assert.equal(scheduler.pending(), 0, 'flush снимает таймер');

  batcher.push('d');
  batcher.dispose();
  assert.equal(scheduler.pending(), 0);
  assert.equal(batcher.pending, '');
});

test('ChatController: send запускает ход и отправляет сообщение пользователя', async () => {
  const { bridge, posts, controller } = createController();

  await controller.send('  привет  ');

  assert.deepEqual(bridge.calls, [
    { method: 'turn.start', params: { sessionId: 'sess_1', input: 'привет' } }
  ]);
  assert.equal(posts[0]?.type, 'message');
  assert.equal(posts[0]?.message.role, 'user');
  assert.equal(posts[0]?.message.text, 'привет');
  assert.deepEqual(posts[1], { type: 'chatStatus', status: 'streaming' });
  assert.equal(controller.status, 'streaming');
  assert.equal(controller.turnId, 'turn_1');
});

test('ChatController: токены батчатся в одно сообщение chatToken', () => {
  const { bridge, scheduler, posts, controller } = createController();
  posts.length = 0;

  bridge.emit('token', { sessionId: 'sess_1', turnId: 'turn_1', text: 'при' });
  bridge.emit('token', { sessionId: 'sess_1', turnId: 'turn_1', text: 'вет' });

  assert.equal(
    posts.filter((message) => message.type === 'chatToken').length,
    0,
    'до сброса токены не отправлены'
  );
  assert.equal(scheduler.pending(), 1, 'запланирован один сброс на пачку');

  scheduler.runNext();
  const sent = posts.filter((message) => message.type === 'chatToken');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].text, 'привет');
  assert.equal(sent[0].turnId, 'turn_1');
  controller.dispose();
});

test('ChatController: tool.call и tool.result превращаются в блоки', () => {
  const { bridge, scheduler, posts, controller } = createController();
  posts.length = 0;

  bridge.emit('token', { turnId: 'turn_1', text: 'думаю' });
  bridge.emit('tool.call', { callId: 'c1', name: 'read_file', arguments: { path: 'a.ts' } });

  const call = posts.find((message) => message.type === 'chatToolCall');
  assert.deepEqual(call?.call, { id: 'c1', name: 'read_file', arguments: { path: 'a.ts' } });
  const tokenAfterCall = posts.find((message) => message.type === 'chatToken');
  assert.equal(tokenAfterCall?.text, 'думаю', 'перед tool.call токены сброшены');
  assert.equal(scheduler.pending(), 0);

  bridge.emit('tool.result', { callId: 'c1', ok: true, result: { bytes: 5 } });
  const result = posts.find((message) => message.type === 'chatToolResult');
  assert.deepEqual(result?.result, { callId: 'c1', ok: true, result: { bytes: 5 } });

  bridge.emit('tool.result', { callId: 'c2', ok: false, error: 'boom' });
  const failed = posts.filter((message) => message.type === 'chatToolResult').at(-1);
  assert.deepEqual(failed?.result, { callId: 'c2', ok: false, error: 'boom' });
  controller.dispose();
});

test('ChatController: turn.done сбрасывает хвост токенов и закрывает ход', () => {
  const { bridge, posts, controller } = createController();
  posts.length = 0;

  bridge.emit('token', { turnId: 'turn_1', text: 'хвост' });
  bridge.emit('turn.done', { turnId: 'turn_1', finishReason: 'stop' });

  const token = posts.find((message) => message.type === 'chatToken');
  assert.equal(token?.text, 'хвост', 'недосланный токен уходит перед chatDone');
  assert.deepEqual(posts.filter((message) => message.type === 'chatDone')[0], {
    type: 'chatDone',
    turnId: 'turn_1',
    finishReason: 'stop'
  });
  assert.deepEqual(posts.at(-1), { type: 'chatStatus', status: 'idle' });
  assert.equal(controller.status, 'idle');
  controller.dispose();
});

test('ChatController: отмена зовёт turn.cancel и помечает поток', async () => {
  const { bridge, posts, controller } = createController();
  posts.length = 0;
  await controller.send('вопрос');
  posts.length = 0;

  await controller.cancel();

  const cancelCall = bridge.calls.find((call) => call.method === 'turn.cancel');
  assert.deepEqual(cancelCall, {
    method: 'turn.cancel',
    params: { sessionId: 'sess_1', turnId: 'turn_1' }
  });
  assert.deepEqual(posts, [
    { type: 'chatCancelled' },
    { type: 'chatStatus', status: 'cancelled' }
  ]);
  assert.equal(controller.status, 'cancelled');
  assert.equal(controller.turnId, null);
  controller.dispose();
});

test('ChatController: ошибка DSH и отсутствие сессии', async () => {
  const { bridge, posts, controller } = createController();
  posts.length = 0;

  bridge.emit('error', { message: 'DSH упал' });
  assert.deepEqual(posts.at(-1), {
    type: 'chatStatus',
    status: 'error',
    detail: 'DSH упал'
  });
  assert.equal(controller.status, 'error');

  const withoutSession = createController({ sessionId: null });
  await assert.rejects(() => withoutSession.controller.send('x'), ChatControllerError);
  withoutSession.controller.dispose();
  controller.dispose();
});

test('ChatController: dispose снимает подписки и не оставляет таймеров', () => {
  const { bridge, scheduler, posts, controller } = createController();
  bridge.emit('token', { turnId: 'turn_1', text: 'a' });
  posts.length = 0;

  controller.dispose();
  assert.equal(bridge.listenerCount(), 0, 'подписки на мост сняты');
  assert.equal(scheduler.pending(), 0, 'таймер батчера снят');

  bridge.emit('token', { turnId: 'turn_1', text: 'b' });
  assert.deepEqual(posts, [], 'после dispose события игнорируются');
});

test('ChatController: поздние токены и чужой turn.done игнорируются', async () => {
  const { bridge, scheduler, posts, controller } = createController();
  await controller.send('вопрос'); // turnId = turn_1
  posts.length = 0;

  bridge.emit('token', { turnId: 'turn_old', text: 'старое' });
  scheduler.runNext();
  assert.equal(
    posts.filter((message) => message.type === 'chatToken').length,
    0,
    'токен прошлого хода не отправлен'
  );

  bridge.emit('token', { turnId: 'turn_1', text: 'новое' });
  scheduler.runNext();
  assert.equal(
    posts.filter((message) => message.type === 'chatToken')[0]?.text,
    'новое'
  );

  bridge.emit('turn.done', { turnId: 'turn_other', finishReason: 'stop' });
  assert.equal(
    posts.filter((message) => message.type === 'chatDone').length,
    0,
    'чужой turn.done не закрывает ход'
  );
  assert.equal(controller.turnId, 'turn_1');
  controller.dispose();
});

test('ChatController: turn.done cancelled оставляет статус cancelled', async () => {
  const { bridge, posts, controller } = createController();
  await controller.send('вопрос');
  posts.length = 0;

  bridge.emit('turn.done', { turnId: 'turn_1', finishReason: 'cancelled' });

  assert.deepEqual(posts.at(-1), { type: 'chatStatus', status: 'cancelled' });
  assert.equal(controller.status, 'cancelled');
  controller.dispose();
});

test('ChatController: отмена во время turn.start гасит уже запущенный ход', async () => {
  let resolveStart;
  const bridge = createBridge({
    handlers: {
      'turn.start': () =>
        new Promise((resolve) => {
          resolveStart = resolve;
        }),
      'turn.cancel': () => ({ cancelled: true })
    }
  });
  const scheduler = createScheduler();
  const posts = [];
  const controller = new ChatController({
    bridge,
    getSessionId: () => 'sess_1',
    post: (message) => {
      posts.push(message);
    },
    schedule: scheduler.schedule,
    cancel: scheduler.cancel
  });

  const sending = controller.send('вопрос');
  await controller.cancel(); // turnId ещё null — отмена запоминается
  resolveStart({ turnId: 'turn_race' });
  await sending;

  const cancelCall = bridge.calls.find((call) => call.method === 'turn.cancel');
  assert.deepEqual(cancelCall, {
    method: 'turn.cancel',
    params: { sessionId: 'sess_1', turnId: 'turn_race' }
  });
  assert.equal(controller.status, 'cancelled');
  assert.equal(controller.turnId, null);
  assert.ok(posts.some((message) => message.type === 'chatCancelled'));
  controller.dispose();
});

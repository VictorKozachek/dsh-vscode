import assert from 'node:assert/strict';
import { register } from 'node:module';
import test from 'node:test';

register('./helpers/ts-loader.mjs', import.meta.url);
const { dispatchWebviewMessage } = await import('../extension/src/views/chatDispatch.ts');
const { ChatController } = await import('../extension/src/views/chatEvents.ts');
const { ChatSession } = await import('../extension/src/views/chatHtml.ts');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const STATE = {
  workspaceName: 'demo-project',
  model: 'deepseek-chat',
  sandboxMode: 'workspace-write',
  locale: 'ru'
};

function createSession(options = {}) {
  return new ChatSession({ replyDelayMs: 0, ...options });
}

function createBridge(handlers = {}) {
  const calls = [];
  const listeners = new Map();
  return {
    calls,
    on(event, listener) {
      const set = listeners.get(event) ?? new Set();
      set.add(listener);
      listeners.set(event, set);
      return { dispose() { set.delete(listener); } };
    },
    async request(method, params) {
      calls.push({ method, params });
      const handler = handlers[method];
      if (handler === undefined) {
        throw new Error(`нет обработчика ${method}`);
      }
      return await handler(params);
    },
    emit(event, payload) {
      for (const listener of listeners.get(event) ?? []) {
        listener(payload);
      }
    }
  };
}

function createOptions({ chat, session = createSession(), posts = [] } = {}) {
  return {
    posts,
    options: {
      chat,
      session,
      state: () => STATE,
      post: (message) => {
        posts.push(message);
      }
    }
  };
}

/** Контроллер, который пишет в тот же список, что и диспетчер. */
function createControllerFor(bridge, posts, sessionId = 'sess_1') {
  return new ChatController({
    bridge,
    getSessionId: () => sessionId,
    post: (message) => {
      posts.push(message);
    }
  });
}

test('эхо-режим (без ChatController): ready и sendMessage обрабатывает ChatSession', async () => {
  const { posts, options } = createOptions();

  await dispatchWebviewMessage({ kind: 'ready' }, options);
  assert.equal(posts[0]?.type, 'state');

  await dispatchWebviewMessage({ kind: 'sendMessage', text: 'привет' }, options);
  await sleep(10);

  const messages = posts.filter((message) => message.type === 'message');
  assert.equal(messages.length, 2, 'сообщение пользователя и ответ-эхо');
  assert.equal(messages[0]?.message.role, 'user');
  assert.equal(messages[1]?.message.role, 'assistant');
  assert.ok(posts.some((message) => message.type === 'status' && message.status === 'thinking'));
});

test('потоковый режим: sendMessage → chat.send (turn.start), stop → chat.cancel', async () => {
  const bridge = createBridge({
    'turn.start': () => ({ turnId: 'turn_1' }),
    'turn.cancel': () => ({ cancelled: true })
  });
  const posts = [];
  const controller = createControllerFor(bridge, posts);
  const { options } = createOptions({ chat: controller, posts });

  await dispatchWebviewMessage({ kind: 'sendMessage', text: 'вопрос' }, options);

  assert.deepEqual(bridge.calls[0], {
    method: 'turn.start',
    params: { sessionId: 'sess_1', input: 'вопрос' }
  });
  assert.equal(posts[0]?.type, 'message');
  assert.equal(posts[1]?.type, 'chatStatus');
  assert.equal(posts[1]?.status, 'streaming');
  assert.equal(posts.filter((message) => message.type === 'message').length, 1, 'эхо не включается');

  await dispatchWebviewMessage({ kind: 'stop' }, options);
  assert.equal(bridge.calls.at(-1)?.method, 'turn.cancel');
  assert.ok(posts.some((message) => message.type === 'chatCancelled'));
  controller.dispose();
});

test('потоковый режим: ready отдаёт состояние панели и статус потока', async () => {
  const bridge = createBridge({});
  const posts = [];
  const controller = createControllerFor(bridge, posts);
  const { options } = createOptions({ chat: controller, posts });

  await dispatchWebviewMessage({ kind: 'ready' }, options);

  assert.equal(posts[0]?.type, 'state');
  assert.deepEqual(posts.at(-1), { type: 'chatStatus', status: 'idle' });
  controller.dispose();
});

test('потоковый режим: ошибка chat.send показывается в панели, а не только в логе', async () => {
  const bridge = createBridge({});
  const posts = [];
  const controller = createControllerFor(bridge, posts, null); // нет активной сессии
  const logs = [];
  const { options } = createOptions({ chat: controller, posts });

  await dispatchWebviewMessage({ kind: 'sendMessage', text: 'вопрос' }, {
    ...options,
    log: (line) => {
      logs.push(line);
    }
  });

  const error = posts.find((message) => message.type === 'chatStatus' && message.status === 'error');
  assert.ok(error, 'ошибка ушла в WebView');
  assert.match(error.detail, /нет активной сессии/);
  assert.ok(logs.some((line) => line.includes('не удалось отправить сообщение')));
  controller.dispose();
});

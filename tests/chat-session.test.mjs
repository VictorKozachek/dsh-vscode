import assert from 'node:assert/strict';
import test from 'node:test';

import { ChatSession } from '../extension/src/views/chatHtml.ts';

const RU_STATE = {
  workspaceName: 'demo-project',
  model: 'deepseek-chat',
  sandboxMode: 'workspace-write',
  locale: 'ru'
};

const EN_STATE = { ...RU_STATE, locale: 'en' };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function session(options = {}) {
  return new ChatSession({ replyDelayMs: 0, ...options });
}

test('ready: состояние панели со статусом idle, лента пустая', () => {
  const chat = session();

  const outgoing = chat.handle({ kind: 'ready' }, () => RU_STATE);

  assert.deepEqual(outgoing, [{ type: 'state', state: { ...RU_STATE, status: 'idle' } }]);
  assert.equal(chat.status, 'idle');
  assert.deepEqual(chat.messages, []);
});

test('sendMessage: сразу thinking и сообщение пользователя, эхо — после паузы', async () => {
  const chat = session();
  const emitted = [];

  const outgoing = chat.handle({ kind: 'sendMessage', text: 'привет' }, () => RU_STATE, (message) => {
    emitted.push(message);
  });

  assert.deepEqual(
    outgoing.map((message) => (message.type === 'status' ? `status:${message.status}` : message.type)),
    ['status:thinking', 'message']
  );
  assert.equal(outgoing[1]?.message.role, 'user');
  assert.equal(outgoing[1]?.message.text, 'привет');
  assert.equal(chat.status, 'thinking', 'до ответа панель в статусе thinking — кнопка «Стоп» активна');

  await sleep(10);

  assert.deepEqual(
    emitted.map((message) => (message.type === 'status' ? `status:${message.status}` : message.message.text)),
    ['Эхо: привет', 'status:idle']
  );
  assert.equal(chat.status, 'idle');
  assert.deepEqual(
    chat.messages.map((message) => message.text),
    ['привет', 'Эхо: привет']
  );
  assert.notEqual(chat.messages[0]?.id, chat.messages[1]?.id);
});

test('sendMessage: для en эхо на английском и подменяемая функция эха', async () => {
  const english = session();
  const englishEmitted = [];
  english.handle({ kind: 'sendMessage', text: 'hello' }, () => EN_STATE, (message) => {
    englishEmitted.push(message);
  });
  await sleep(10);
  assert.equal(englishEmitted[0]?.message.text, 'Echo: hello');

  const custom = session({ echo: (text, locale) => `${locale}:${text}` });
  const customEmitted = [];
  custom.handle({ kind: 'sendMessage', text: 'x' }, () => EN_STATE, (message) => {
    customEmitted.push(message);
  });
  await sleep(10);
  assert.equal(customEmitted[0]?.message.text, 'en:x');
});

test('stop: отменяет неотправленный ответ и включает статус stopped', async () => {
  const chat = new ChatSession({ replyDelayMs: 40 });
  const emitted = [];

  chat.handle({ kind: 'sendMessage', text: 'вопрос' }, () => RU_STATE, (message) => {
    emitted.push(message);
  });
  const stopped = chat.handle({ kind: 'stop' }, () => RU_STATE);

  assert.deepEqual(stopped, [{ type: 'status', status: 'stopped' }]);
  assert.equal(chat.status, 'stopped');

  await sleep(80);
  assert.deepEqual(emitted, [], 'ответ после Стоп не приходит');
  assert.equal(chat.messages.length, 1, 'в ленте осталось только сообщение пользователя');

  const ready = chat.handle({ kind: 'ready' }, () => RU_STATE);
  assert.equal(ready[0]?.type, 'state');
  assert.deepEqual(ready[0].state, { ...RU_STATE, status: 'stopped' });
  assert.equal(ready[1]?.type, 'replaceMessages', 'лента с сообщением пользователя восстанавливается');
});

test('append до открытия панели: на ready приходит replaceMessages', () => {
  const chat = session();
  const appended = chat.append({ id: 'assistant-1', role: 'assistant', text: 'из extension' });
  assert.deepEqual(appended, [
    { type: 'message', message: { id: 'assistant-1', role: 'assistant', text: 'из extension' } }
  ]);

  const outgoing = chat.handle({ kind: 'ready' }, () => RU_STATE);
  assert.equal(outgoing.length, 2);
  assert.equal(outgoing[0]?.type, 'state');
  assert.equal(outgoing[1]?.type, 'replaceMessages');
  assert.deepEqual(outgoing[1].messages, [
    { id: 'assistant-1', role: 'assistant', text: 'из extension' }
  ]);
});

test('dispose: снимает неотправленный ответ', async () => {
  const chat = new ChatSession({ replyDelayMs: 40 });
  const emitted = [];
  chat.handle({ kind: 'sendMessage', text: 'x' }, () => RU_STATE, (message) => {
    emitted.push(message);
  });

  chat.dispose();
  await sleep(80);
  assert.deepEqual(emitted, []);
  assert.equal(chat.messages.length, 1);
});

test('лента ограничена maxMessages', async () => {
  const chat = session({ maxMessages: 2 });

  chat.handle({ kind: 'sendMessage', text: 'первое' }, () => RU_STATE);
  await sleep(10);
  chat.handle({ kind: 'sendMessage', text: 'второе' }, () => RU_STATE);
  await sleep(10);

  assert.equal(chat.messages.length, 2);
  assert.deepEqual(
    chat.messages.map((message) => message.role),
    ['user', 'assistant']
  );
  assert.equal(chat.messages[0]?.text, 'второе');
});

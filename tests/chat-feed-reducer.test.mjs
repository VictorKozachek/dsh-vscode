import assert from 'node:assert/strict';
import test from 'node:test';

import {
  chatFeedReducer,
  initialChatFeedState,
  shouldAutoScroll
} from '../webview/src/chat/reducer.ts';

const state = () => initialChatFeedState;

test('лента: сообщение пользователя и статус', () => {
  const next = chatFeedReducer(state(), { type: 'userMessage', text: 'привет' });

  assert.equal(next.entries.length, 1);
  assert.equal(next.entries[0]?.role, 'user');
  assert.equal(next.entries[0]?.text, 'привет');
  assert.equal(next.entries[0]?.state, 'done');
  assert.equal(next.status, 'idle');
});

test('лента: токены собираются в одно streaming-сообщение', () => {
  let current = chatFeedReducer(state(), { type: 'userMessage', text: 'вопрос' });
  current = chatFeedReducer(current, { type: 'token', turnId: 'turn_1', text: 'при' });
  current = chatFeedReducer(current, { type: 'token', turnId: 'turn_1', text: 'вет' });

  assert.equal(current.entries.length, 2);
  assert.equal(current.entries[1]?.role, 'assistant');
  assert.equal(current.entries[1]?.text, 'привет');
  assert.equal(current.entries[1]?.state, 'streaming');
  assert.equal(current.status, 'streaming');
  assert.equal(current.turnId, 'turn_1');
});

test('лента: после отмены токены игнорируются', () => {
  let current = chatFeedReducer(state(), { type: 'token', turnId: 't1', text: 'a' });
  current = chatFeedReducer(current, { type: 'cancelled' });
  const afterCancel = chatFeedReducer(current, { type: 'token', turnId: 't1', text: 'b' });

  assert.equal(afterCancel, current, 'токены после отмены не меняют состояние');
  assert.equal(afterCancel.entries[0]?.text, 'a');
});

test('лента: tool.call создаёт блок, tool.result обновляет его', () => {
  let current = chatFeedReducer(state(), { type: 'token', turnId: 't', text: 'думаю' });
  current = chatFeedReducer(current, {
    type: 'toolCall',
    callId: 'call_1',
    name: 'read_file',
    arguments: { path: 'a.ts' },
    at: 1000
  });

  const call = current.entries[0]?.toolCalls[0];
  assert.equal(call?.id, 'call_1');
  assert.equal(call?.status, 'running');
  assert.equal(call?.startedAt, 1000);

  current = chatFeedReducer(current, {
    type: 'toolResult',
    callId: 'call_1',
    ok: true,
    result: { bytes: 10 },
    at: 1500
  });

  const finished = current.entries[0]?.toolCalls[0];
  assert.equal(finished?.status, 'done');
  assert.deepEqual(finished?.result, { bytes: 10 });
  assert.equal(finished?.finishedAt, 1500);
});

test('лента: tool.call без streaming-сообщения создаёт assistant-запись', () => {
  const current = chatFeedReducer(state(), {
    type: 'toolCall',
    callId: 'c2',
    name: 'run',
    arguments: {},
    at: 5
  });

  assert.equal(current.entries.length, 1);
  assert.equal(current.entries[0]?.role, 'assistant');
  assert.equal(current.entries[0]?.toolCalls[0]?.id, 'c2');
});

test('лента: ошибка инструмента и ошибка хода', () => {
  let current = chatFeedReducer(state(), { type: 'token', turnId: 't', text: 'x' });
  current = chatFeedReducer(current, {
    type: 'toolCall',
    callId: 'c3',
    name: 'fail',
    arguments: {},
    at: 1
  });
  current = chatFeedReducer(current, {
    type: 'toolResult',
    callId: 'c3',
    ok: false,
    error: 'boom',
    at: 2
  });
  assert.equal(current.entries[0]?.toolCalls[0]?.status, 'error');
  assert.equal(current.entries[0]?.toolCalls[0]?.error, 'boom');

  current = chatFeedReducer(current, { type: 'error', message: 'DSH упал' });
  assert.equal(current.status, 'error');
  assert.equal(current.error, 'DSH упал');
  assert.equal(current.entries[0]?.state, 'error');
});

test('лента: turn.done закрывает ход, cancelled и error помечают сообщение', () => {
  let done = chatFeedReducer(state(), { type: 'token', turnId: 't', text: 'ответ' });
  done = chatFeedReducer(done, { type: 'done', turnId: 't', finishReason: 'stop' });
  assert.equal(done.status, 'idle');
  assert.equal(done.entries[0]?.state, 'done');
  assert.equal(done.turnId, null);

  let cancelled = chatFeedReducer(state(), { type: 'token', turnId: 't', text: 'ответ' });
  cancelled = chatFeedReducer(cancelled, { type: 'cancelled' });
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.entries[0]?.state, 'cancelled');

  let failed = chatFeedReducer(state(), { type: 'token', turnId: 't', text: 'ответ' });
  failed = chatFeedReducer(failed, { type: 'done', turnId: 't', finishReason: 'error' });
  assert.equal(failed.status, 'error');
  assert.equal(failed.entries[0]?.state, 'error');
});

test('лента: appendMessage и replaceMessages', () => {
  let current = chatFeedReducer(state(), {
    type: 'appendMessage',
    message: { id: 'assistant-1', role: 'assistant', text: 'из extension' }
  });
  assert.equal(current.entries.length, 1);

  current = chatFeedReducer(current, {
    type: 'replaceMessages',
    messages: [
      { id: 'u1', role: 'user', text: 'вопрос' },
      { id: 'a1', role: 'assistant', text: 'ответ' }
    ]
  });
  assert.equal(current.entries.length, 2);
  assert.equal(current.entries[1]?.text, 'ответ');
  assert.equal(current.status, 'idle');
});

test('автоскролл: только у нижней границы', () => {
  assert.equal(
    shouldAutoScroll({ scrollTop: 1000, scrollHeight: 1500, clientHeight: 500 }),
    true
  );
  assert.equal(
    shouldAutoScroll({ scrollTop: 500, scrollHeight: 1500, clientHeight: 500 }),
    false
  );
  assert.equal(
    shouldAutoScroll({ scrollTop: 960, scrollHeight: 1500, clientHeight: 500 }),
    true,
    'в пределах порога 48 px'
  );
  assert.equal(
    shouldAutoScroll({ scrollTop: 0, scrollHeight: 400, clientHeight: 500 }),
    true,
    'контент короче окна — скроллить некуда'
  );
});

test('лента: поздние токены и чужой turn.done не портят текущий ответ', () => {
  let current = chatFeedReducer(state(), { type: 'token', turnId: 'turn_1', text: 'один' });
  const lateToken = chatFeedReducer(current, { type: 'token', turnId: 'turn_old', text: 'старое' });

  assert.equal(lateToken, current, 'токен другого хода игнорируется');
  assert.equal(lateToken.entries[0]?.text, 'один');

  const lateDone = chatFeedReducer(current, { type: 'done', turnId: 'turn_old', finishReason: 'stop' });
  assert.equal(lateDone, current, 'чужой turn.done не закрывает текущий ход');
});

test('лента: done cancelled оставляет статус cancelled', () => {
  let current = chatFeedReducer(state(), { type: 'token', turnId: 'turn_1', text: 'ответ' });
  current = chatFeedReducer(current, { type: 'done', turnId: 'turn_1', finishReason: 'cancelled' });

  assert.equal(current.status, 'cancelled');
  assert.equal(current.entries[0]?.state, 'cancelled');
});

test('лента: после отмены tool-события игнорируются, running-вызовы прерываются', () => {
  let current = chatFeedReducer(state(), { type: 'token', turnId: 'turn_1', text: 'думаю' });
  current = chatFeedReducer(current, {
    type: 'toolCall',
    callId: 'call_1',
    name: 'read_file',
    arguments: {},
    at: 10
  });
  current = chatFeedReducer(current, { type: 'cancelled' });

  const call = current.entries[0]?.toolCalls[0];
  assert.equal(call?.status, 'error', 'незавершённый вызов помечен ошибкой');
  assert.equal(call?.error, 'cancelled');

  const lateCall = chatFeedReducer(current, {
    type: 'toolCall',
    callId: 'call_2',
    name: 'late',
    arguments: {},
    at: 20
  });
  assert.equal(lateCall, current, 'tool.call после отмены игнорируется');

  const lateResult = chatFeedReducer(current, {
    type: 'toolResult',
    callId: 'call_1',
    ok: true,
    at: 30
  });
  assert.equal(lateResult, current, 'tool.result после отмены игнорируется');
});

test('replaceFeed восстанавливает порядок user → tool → result → assistant', () => {
  const state = chatFeedReducer(initialChatFeedState, {
    type: 'replaceFeed',
    records: [
      { kind: 'message', message: { id: 'u1', role: 'user', text: 'прочитай' } },
      { kind: 'toolCall', callId: 'c1', name: 'read_file', arguments: { path: 'a.ts' } },
      { kind: 'toolResult', callId: 'c1', ok: true, result: { bytes: 1 } },
      { kind: 'message', message: { id: 'a1', role: 'assistant', text: 'готово' } }
    ]
  });

  assert.deepEqual(
    state.entries.map((entry) => [entry.role, entry.text, entry.toolCalls.length]),
    [
      ['user', 'прочитай', 0],
      ['assistant', '', 1],
      ['assistant', 'готово', 0]
    ]
  );
  assert.equal(state.entries[1].toolCalls[0].status, 'done');
  assert.deepEqual(state.entries[1].toolCalls[0].result, { bytes: 1 });
  assert.equal(state.status, 'idle');
});

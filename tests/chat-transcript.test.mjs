import assert from 'node:assert/strict';
import test from 'node:test';

import { SessionTranscriptStore } from '../extension/src/views/chatTranscript.ts';

test('история по сессиям: сообщения и tool-записи раздельны', () => {
  const store = new SessionTranscriptStore();
  store.appendUser('sess-a', 'вопрос A');
  store.appendAssistantToken('sess-a', 'ответ');
  store.appendToolCall('sess-a', { callId: 'c1', name: 'read_file', arguments: { path: 'a.ts' } });
  store.appendToolResult('sess-a', { callId: 'c1', ok: true, result: { bytes: 1 } });
  store.appendUser('sess-b', 'вопрос B');

  assert.deepEqual(
    store.messagesFor('sess-a').map((message) => [message.role, message.text]),
    [
      ['user', 'вопрос A'],
      ['assistant', 'ответ']
    ]
  );
  assert.equal(store.messagesFor('sess-b').length, 1);
  assert.equal(store.hasHistory('sess-a'), true);
  assert.equal(store.hasHistory('sess-c'), false);

  const records = store.recordsFor('sess-a');
  assert.deepEqual(records.map((record) => record.kind), [
    'message',
    'message',
    'toolCall',
    'toolResult'
  ]);

  store.clear('sess-a');
  assert.equal(store.hasHistory('sess-a'), false);
  assert.equal(store.messagesFor('sess-b').length, 1);
});

test('токены дописываются в assistant-сообщение, а не создают новые', () => {
  const store = new SessionTranscriptStore();
  store.appendUser('s', 'q');
  store.appendAssistantToken('s', 'при');
  store.appendAssistantToken('s', 'вет');
  assert.deepEqual(
    store.messagesFor('s').map((message) => message.text),
    ['q', 'привет']
  );
});

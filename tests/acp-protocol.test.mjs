import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AcpUnsupportedMethodError,
  mapAcpNotification,
  mapCreateResult,
  mapListResult,
  mapPromptOutcome,
  mapResumeResult,
  toAcpCall
} from '../extension/src/runtime/acpProtocol.ts';

const CWD = '/repo';

test('наши методы → вызовы ACP', () => {
  assert.deepEqual(toAcpCall('session.list', {}, CWD), {
    method: 'session/list',
    params: { cwd: CWD }
  });
  assert.deepEqual(toAcpCall('session.create', { workspaceId: 'ws' }, CWD), {
    method: 'session/new',
    params: { cwd: CWD, mcpServers: [] }
  });
  assert.deepEqual(toAcpCall('session.resume', { sessionId: 'sess-1' }, CWD), {
    method: 'session/resume',
    params: { sessionId: 'sess-1', cwd: CWD, mcpServers: [] }
  });
  assert.deepEqual(toAcpCall('turn.start', { sessionId: 'sess-1', input: 'привет' }, CWD), {
    method: 'session/prompt',
    params: { sessionId: 'sess-1', prompt: [{ type: 'text', text: 'привет' }] }
  });
  const cancel = toAcpCall('turn.cancel', { sessionId: 'sess-1', turnId: 't1' }, CWD);
  assert.equal(cancel.method, 'session/cancel');
  assert.equal(cancel.notification, true);
});

test('неподдержанные методы — понятная ошибка, ping локальный', () => {
  for (const method of ['tools.invoke', 'approval.resolve', 'context.reload']) {
    assert.throws(
      () => toAcpCall(method, {}, CWD),
      (error) => error instanceof AcpUnsupportedMethodError
    );
  }
  assert.equal(toAcpCall('workspace.ping', {}, CWD), null);
});

test('результаты ACP → наши результаты', () => {
  assert.deepEqual(
    mapListResult(
      {
        sessions: [
          { sessionId: 'sess-1', cwd: CWD, title: 'Первая', updatedAt: '2026-11-09T10:00:00.000Z' },
          { sessionId: 'sess-2', cwd: CWD },
          { cwd: CWD }
        ]
      },
      'ws-1',
      CWD,
      '2026-11-09T12:00:00.000Z'
    ),
    {
      sessions: [
        {
          id: 'sess-1',
          workspaceId: 'ws-1',
          title: 'Первая',
          updatedAt: '2026-11-09T10:00:00.000Z'
        },
        { id: 'sess-2', workspaceId: 'ws-1', updatedAt: '2026-11-09T12:00:00.000Z' }
      ]
    }
  );

  assert.deepEqual(mapCreateResult({ sessionId: 'sess-9' }, '2026-11-09T12:00:00.000Z'), {
    sessionId: 'sess-9',
    createdAt: '2026-11-09T12:00:00.000Z'
  });
  assert.throws(() => mapCreateResult({}, '2026-11-09T12:00:00.000Z'));

  assert.deepEqual(
    mapResumeResult({ configOptions: [] }, 'sess-1', 'ws-1', '2026-11-09T12:00:00.000Z'),
    { session: { id: 'sess-1', workspaceId: 'ws-1', updatedAt: '2026-11-09T12:00:00.000Z' } }
  );
});

test('результат prompt → turn.done', () => {
  assert.deepEqual(mapPromptOutcome('sess-1', 'turn-1', { stopReason: 'end_turn' }), {
    event: 'turn.done',
    payload: { sessionId: 'sess-1', turnId: 'turn-1', finishReason: 'stop' }
  });
  assert.equal(
    mapPromptOutcome('s', 't', { stopReason: 'cancelled' }).payload.finishReason,
    'cancelled'
  );
  assert.equal(mapPromptOutcome('s', 't', { stopReason: 'refusal' }).payload.finishReason, 'error');
});

test('session/update → токены и tool-события', () => {
  assert.deepEqual(
    mapAcpNotification('session/update', {
      sessionId: 'sess-1',
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'при' } }
    }),
    { event: 'token', payload: { sessionId: 'sess-1', turnId: 'sess-1', text: 'при' } }
  );

  assert.deepEqual(
    mapAcpNotification('session/update', {
      sessionId: 'sess-1',
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'c1',
        title: 'read_file',
        rawInput: { path: 'a.ts' }
      }
    }),
    {
      event: 'tool.call',
      payload: {
        sessionId: 'sess-1',
        callId: 'c1',
        name: 'read_file',
        arguments: { path: 'a.ts' }
      }
    }
  );

  assert.deepEqual(
    mapAcpNotification('session/update', {
      sessionId: 'sess-1',
      update: { sessionUpdate: 'tool_call_update', toolCallId: 'c1', status: 'failed', title: 'boom' }
    }),
    {
      event: 'tool.result',
      payload: { sessionId: 'sess-1', callId: 'c1', ok: false, error: 'boom' }
    }
  );

  assert.equal(
    mapAcpNotification('session/update', {
      sessionId: 'sess-1',
      update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'думаю' } }
    }),
    null
  );
  assert.equal(mapAcpNotification('other/method', {}), null);
});

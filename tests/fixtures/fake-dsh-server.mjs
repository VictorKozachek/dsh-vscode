#!/usr/bin/env node
/**
 * Фейковый `dsh serve` для тестов DshBridge: говорит NDJSON JSON-RPC 2.0 по
 * stdio. Поведение задаётся переменной окружения `FAKE_DSH_MODE`:
 *
 * - `normal` — отвечает на все методы;
 * - `no-ping` — молчит на `workspace.ping` (healthcheck не проходит);
 * - `crash-after-ready` — отвечает на ping и через 60 мс падает;
 * - `crash-once-on-create` — на первом `session.create` падает, второй процесс
 *   (маркер в `FAKE_DSH_MARKER_FILE`) работает нормально;
 * - `exit-immediately` — завершается с кодом 7 сразу при старте;
 * - `ignore-sigterm` — игнорирует SIGTERM (проверка эскалации до SIGKILL);
 * - `no-response` — не отвечает ни на один запрос (таймауты, отмена);
 * - `noisy` — пишет в stderr и не-JSON строку в stdout;
 * - `server-request` — присылает клиенту запрос `client.do`.
 */

import { existsSync, writeFileSync } from 'node:fs';

const mode = process.env['FAKE_DSH_MODE'] ?? 'normal';
const markerFile = process.env['FAKE_DSH_MARKER_FILE'];
const args = process.argv.slice(2);
const cwdIndex = args.indexOf('--cwd');
const workspace = cwdIndex >= 0 ? args[cwdIndex + 1] : process.cwd();

if (mode === 'ignore-sigterm') {
  process.on('SIGTERM', () => {
    // намеренно не завершаемся: супервизор должен дойти до SIGKILL
  });
}

if (mode === 'exit-immediately') {
  process.exit(7);
}

if (mode === 'noisy') {
  process.stderr.write('fake-dsh: stderr жив\n');
  process.stdout.write('это не JSON, а мусор в stdout\n');
}

const send = (message) => {
  process.stdout.write(`${JSON.stringify(message)}\n`);
};

const respond = (id, result) => {
  send({ jsonrpc: '2.0', id, result });
};

const respondError = (id, code, message) => {
  send({ jsonrpc: '2.0', id, error: { code, message } });
};

const notify = (method, params) => {
  send({ jsonrpc: '2.0', method, params });
};

if (mode === 'server-request') {
  send({ jsonrpc: '2.0', id: 'srv-1', method: 'client.do', params: { hello: 'client' } });
}

/** `crash-once-on-create`: падаем только в первом процессе. */
function shouldCrashOnCreate() {
  if (mode !== 'crash-once-on-create') {
    return false;
  }
  if (markerFile === undefined) {
    return true;
  }
  if (existsSync(markerFile)) {
    return false;
  }
  writeFileSync(markerFile, '1');
  return true;
}

function handleRequest(id, method, params) {
  // В режиме no-response молчим на всё, кроме healthcheck: иначе мост не поднимется.
  if (mode === 'no-response' && method !== 'workspace.ping') {
    return;
  }

  switch (method) {
    case 'workspace.ping': {
      if (mode === 'no-ping') {
        return;
      }
      respond(id, { pong: true, protocolVersion: '0.1.0', workspace });
      if (mode === 'crash-after-ready') {
        setTimeout(() => {
          process.exit(2);
        }, 60);
      }
      return;
    }
    case 'session.create': {
      if (shouldCrashOnCreate()) {
        process.exit(3);
      }
      respond(id, { sessionId: 'sess_fake', createdAt: new Date().toISOString() });
      return;
    }
    case 'session.resume':
      respond(id, {
        session: {
          id: params?.sessionId ?? 'sess_fake',
          workspaceId: 'ws_fake',
          updatedAt: new Date().toISOString()
        }
      });
      return;
    case 'session.list':
      respond(id, { sessions: [] });
      return;
    case 'turn.start': {
      const sessionId = params?.sessionId ?? 'sess_fake';
      const turnId = 'turn_1';
      respond(id, { turnId, sessionId });
      notify('token', { sessionId, turnId, text: 'привет' });
      notify('token', { sessionId, turnId, text: ', мир' });
      notify('turn.done', { sessionId, turnId, finishReason: 'stop' });
      return;
    }
    case 'turn.cancel':
      respond(id, { cancelled: true });
      return;
    case 'tools.invoke': {
      if (params?.arguments?.fail === true) {
        respondError(id, -32001, 'инструмент упал намеренно');
        return;
      }
      respond(id, { ok: true, result: { echo: params?.arguments ?? {} } });
      return;
    }
    case 'approval.resolve':
      respond(id, { resolved: true });
      return;
    case 'context.reload':
      respond(id, { reloaded: true, hash: 'sha256:fake' });
      return;
    default:
      respondError(id, -32601, `method not found: ${String(method)}`);
  }
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let newline = buffer.indexOf('\n');
  while (newline >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (line !== '') {
      handleLine(line);
    }
    newline = buffer.indexOf('\n');
  }
});

function handleLine(line) {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message === null || typeof message !== 'object') {
    return;
  }
  const hasId = typeof message.id === 'number' || typeof message.id === 'string';
  if (typeof message.method === 'string' && hasId) {
    handleRequest(message.id, message.method, message.params);
    return;
  }
  // Уведомления клиента (например, ответ на server-request) просто логируем.
  if (typeof message.method === 'string') {
    process.stderr.write(`fake-dsh: уведомление клиента ${message.method}\n`);
    return;
  }
  if (hasId && ('result' in message || 'error' in message)) {
    process.stderr.write(`fake-dsh: ответ клиента на ${String(message.id)}\n`);
  }
}

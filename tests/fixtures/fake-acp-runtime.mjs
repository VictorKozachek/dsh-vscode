#!/usr/bin/env node
/**
 * Фейковый ACP-рантайм для интеграционных тестов #021.
 *
 * Говорит по NDJSON JSON-RPC, как `dsh --profile acp`: initialize,
 * session/list, session/new, session/resume, session/close, session/prompt,
 * session/cancel. Поведение настраивается переменными окружения:
 * - FAKE_ACP_CRASH_FILE — путь-маркер: первый session/list пишет маркер и
 *   роняет процесс (проверка backoff-рестарта);
 * - FAKE_ACP_HANG_PROMPT=1 — prompt не завершается, пока не придёт cancel;
 * - FAKE_ACP_LOG — файл, куда пишутся пришедшие методы (проверка notification).
 */

import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const logPath = process.env.FAKE_ACP_LOG;
let nextSession = 1;
let pendingPrompt;
let pendingPermission;
const pendingRequests = new Map();
const grandchildFile = process.env.FAKE_ACP_GRANDCHILD_PID_FILE;
if (typeof grandchildFile === 'string' && grandchildFile !== '') {
  const grandchild = spawn(
    process.execPath,
    ['-e', 'setInterval(() => {}, 1000)'],
    { stdio: 'ignore' }
  );
  writeFileSync(grandchildFile, String(grandchild.pid));
}

function logMethod(method) {
  if (typeof logPath === 'string' && logPath !== '') {
    appendFileSync(logPath, `${method}\n`);
  }
}

function respond(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
}

function respondError(id, code, message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })}\n`);
}

function notify(method, params) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
}

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on('line', (line) => {
  const trimmed = line.trim();
  if (trimmed === '') {
    return;
  }
  let message;
  try {
    message = JSON.parse(trimmed);
  } catch {
    return;
  }
  const method = typeof message.method === 'string' ? message.method : '';
  const params = message.params ?? {};
  logMethod(method);

  if (
    message.id !== undefined &&
    pendingRequests.has(message.id) &&
    (message.result !== undefined || message.error !== undefined)
  ) {
    if (typeof logPath === 'string' && logPath !== '') {
      appendFileSync(logPath, `response:${message.id}:${JSON.stringify(message.result ?? message.error)}\n`);
    }
    const resolve = pendingRequests.get(message.id);
    pendingRequests.delete(message.id);
    resolve?.(message.result ?? message.error);
    return;
  }

  if (message.id === 900 && (message.result !== undefined || message.error !== undefined)) {
    if (typeof logPath === 'string' && logPath !== '') {
      appendFileSync(logPath, `response:900:${JSON.stringify(message.result ?? message.error)}\n`);
    }
    const pending = pendingPermission;
    pendingPermission = undefined;
    if (pending !== undefined) {
      pending();
    }
    return;
  }

  switch (method) {
    case 'initialize': {
      if (process.env.FAKE_ACP_INIT_ERROR === '1') {
        respondError(message.id, -32000, 'initialize failed');
        return;
      }
      const sendInit = () => {
        respond(message.id, {
          protocolVersion: 1,
          agentInfo: { name: 'fake-acp', version: '9.9.9' },
          agentCapabilities: { sessionCapabilities: { list: {}, resume: {}, close: {} } },
          authMethods: []
        });
        if (process.env.FAKE_ACP_CRASH_AFTER_INIT === '1') {
          setTimeout(() => process.exit(1), 5);
        }
      };
      const delay = Number(process.env.FAKE_ACP_INIT_DELAY ?? '0');
      if (Number.isFinite(delay) && delay > 0) {
        setTimeout(sendInit, delay);
      } else {
        sendInit();
      }
      return;
    }

    case 'session/list': {
      const crashFile = process.env.FAKE_ACP_CRASH_FILE;
      if (typeof crashFile === 'string' && crashFile !== '' && !existsSync(crashFile)) {
        writeFileSync(crashFile, 'crashed');
        process.exit(1);
      }
      respond(message.id, {
        sessions: [
          {
            sessionId: 'sess-existing',
            cwd: typeof params.cwd === 'string' ? params.cwd : '',
            title: 'существующая сессия',
            updatedAt: '2026-11-09T10:00:00.000Z'
          }
        ]
      });
      return;
    }

    case 'session/new': {
      const sessionId = `sess-${String(nextSession)}`;
      nextSession += 1;
      respond(message.id, { sessionId, configOptions: [] });
      return;
    }

    case 'session/resume':
      respond(message.id, { configOptions: [] });
      return;

    case 'session/close':
      respond(message.id, {});
      return;

    case 'diagnostics/report':
      respond(message.id, { accepted: true });
      return;

    case 'session/prompt': {
      const sessionId = typeof params.sessionId === 'string' ? params.sessionId : '';
      const finish = (stopReason) => {
        respond(message.id, { stopReason });
      };
      const inputText =
        Array.isArray(params.prompt) && typeof params.prompt[0]?.text === 'string'
          ? params.prompt[0].text
          : '';
      const emitUpdates = () => {
        notify('session/update', {
          sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: {
              type: 'text',
              text: process.env.FAKE_ACP_ECHO_PROMPT === '1' ? inputText : 'Привет, '
            }
          }
        });
        notify('session/update', {
          sessionId,
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'мир!' } }
        });
        notify('session/update', {
          sessionId,
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'call-1',
            title: 'read_file',
            kind: 'read',
            status: 'pending',
            rawInput: { path: 'README.md' }
          }
        });
        notify('session/update', {
          sessionId,
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: 'call-1',
            status: 'completed',
            rawOutput: { bytes: 42 }
          }
        });
      };

      const runUpdates = () => {
        if (process.env.FAKE_ACP_TERMINAL === '1') {
          let requestId = 900;
          const requestClient = (method, params) =>
            new Promise((resolve) => {
              requestId += 1;
              pendingRequests.set(requestId, resolve);
              process.stdout.write(
                `${JSON.stringify({
                  jsonrpc: '2.0',
                  id: requestId,
                  method,
                  params
                })}\n`
              );
            });
          void (async () => {
            const created = await requestClient('terminal/create', {
              sessionId,
              command: 'echo',
              args: ['hi'],
              cwd: process.cwd()
            });
            const terminalId = created?.terminalId;
            await requestClient('terminal/output', { terminalId });
            await requestClient('terminal/wait_for_exit', { terminalId });
            emitUpdates();
            setTimeout(() => finish('end_turn'), 10);
          })();
          return;
        }
        if (process.env.FAKE_ACP_PERMISSION === '1') {
          pendingPermission = () => {
            emitUpdates();
            setTimeout(() => finish('end_turn'), 10);
          };
          process.stdout.write(
            `${JSON.stringify({
              jsonrpc: '2.0',
              id: 900,
              method: 'session/request_permission',
              params: {
                sessionId,
                toolCall: { toolCallId: 'call-perm', title: 'write_file' },
                options: [
                  { optionId: 'allow', name: 'Allow' },
                  { optionId: 'deny', name: 'Deny' }
                ]
              }
            })}\n`
          );
          return;
        }
        emitUpdates();
        setTimeout(() => finish('end_turn'), 10);
      };

      if (process.env.FAKE_ACP_HANG_PROMPT === '1') {
        pendingPrompt = { id: message.id, sessionId, emitUpdates, finish };
        emitUpdates();
        return;
      }
      runUpdates();
      return;
    }

    case 'session/cancel': {
      const pending = pendingPrompt;
      pendingPrompt = undefined;
      if (pending !== undefined) {
        pending.emitUpdates();
        pending.finish('cancelled');
      }
      // session/cancel — notification, ответа нет
      return;
    }

    default:
      if (message.id !== undefined) {
        respondError(message.id, -32601, `fake-acp: метод ${method} не поддержан`);
      }
  }
});

process.on('SIGTERM', () => {
  process.exit(0);
});

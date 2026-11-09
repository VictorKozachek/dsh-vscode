import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { DshBridge, DshBridgeError, defaultDshCommand } from '../extension/src/bridge/dshBridge.ts';

const fixturesDirectory = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const fakeServer = path.join(fixturesDirectory, 'fake-dsh-server.mjs');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, description, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await sleep(10);
  }
  throw new Error(`не дождались: ${description}`);
}

/** Мост с фейковым сервером вместо `dsh serve`. */
function createBridge(t, { mode = 'normal', env = {}, options = {} } = {}) {
  const logs = [];
  const bridge = new DshBridge({
    cwd: os.tmpdir(),
    executablePath: process.execPath,
    commandBuilder: (input) => ({
      executable: process.execPath,
      args: [fakeServer, '--cwd', input.cwd]
    }),
    environment: { FAKE_DSH_MODE: mode, ...env },
    requestTimeoutMs: 1000,
    healthcheckTimeoutMs: 1000,
    shutdownGraceMs: 300,
    initialRestartDelayMs: 20,
    restartDelayFactor: 2,
    maxRestartDelayMs: 120,
    maxRestartAttempts: 3,
    logger: { appendLine: (line) => logs.push(line) },
    ...options
  });
  t.after(() => {
    bridge.dispose();
  });
  return { bridge, logs };
}

test('start(): процесс поднят, healthcheck пройден, dispose снимает процесс', async (t) => {
  const { bridge, logs } = createBridge(t);

  await bridge.start();
  assert.equal(bridge.state, 'running');
  assert.equal(bridge.processCount, 1);
  assert.ok(logs.some((line) => line.includes('healthcheck DSH пройден')));

  bridge.dispose();
  assert.equal(bridge.state, 'stopped');
  assert.equal(bridge.processCount, 0);
});

test('request(): корреляция запросов и ответов', async (t) => {
  const { bridge } = createBridge(t);
  await bridge.start();

  const created = await bridge.request('session.create', { workspaceId: 'ws_fake' });
  assert.equal(created.sessionId, 'sess_fake');
  assert.match(created.createdAt, /^\d{4}-\d{2}-\d{2}T/);

  const [sessions, invoked, reloaded] = await Promise.all([
    bridge.request('session.list', {}),
    bridge.request('tools.invoke', { sessionId: 'sess_fake', name: 'echo', arguments: { x: 1 } }),
    bridge.request('context.reload', { workspaceId: 'ws_fake' })
  ]);
  assert.deepEqual(sessions.sessions, []);
  assert.deepEqual(invoked.result, { echo: { x: 1 } });
  assert.equal(reloaded.reloaded, true);
});

test('request(): одновременные запросы не путают id', async (t) => {
  const { bridge } = createBridge(t);
  await bridge.start();

  const results = await Promise.all(
    Array.from({ length: 12 }, (_, index) =>
      bridge.request('tools.invoke', {
        sessionId: `sess_${String(index)}`,
        name: 'echo',
        arguments: { index }
      })
    )
  );

  assert.equal(results.length, 12);
  for (const [index, result] of results.entries()) {
    assert.deepEqual(result.result, { echo: { index } });
  }
});

test('events: turn.start приносит token и turn.done', async (t) => {
  const { bridge } = createBridge(t);
  await bridge.start();

  const tokens = [];
  const done = [];
  bridge.on('token', (payload) => {
    tokens.push(payload);
  });
  bridge.on('turn.done', (payload) => {
    done.push(payload);
  });

  const started = await bridge.request('turn.start', { sessionId: 'sess_fake', input: 'привет' });
  assert.equal(started.turnId, 'turn_1');

  await waitFor(() => tokens.length === 2 && done.length === 1, 'события хода');
  assert.deepEqual(
    tokens.map((token) => token.text),
    ['привет', ', мир']
  );
  assert.equal(done[0]?.finishReason, 'stop');
});

test('ошибка JSON-RPC отклоняет запрос с кодом и сообщением', async (t) => {
  const { bridge } = createBridge(t);
  await bridge.start();

  await assert.rejects(
    bridge.request('tools.invoke', {
      sessionId: 'sess_fake',
      name: 'fail',
      arguments: { fail: true }
    }),
    (error) => {
      assert.ok(error instanceof DshBridgeError);
      assert.equal(error.code, -32001);
      assert.match(error.message, /инструмент упал намеренно/);
      return true;
    }
  );
});

test('таймаут запроса и отмена через AbortSignal', async (t) => {
  const { bridge } = createBridge(t, { mode: 'no-response' });
  await bridge.start();

  await assert.rejects(
    bridge.request('session.list', {}, { timeoutMs: 100 }),
    /таймаут запроса session\.list/
  );

  const controller = new AbortController();
  const aborted = bridge.request('session.list', {}, { signal: controller.signal, timeoutMs: 5000 });
  setTimeout(() => {
    controller.abort();
  }, 30);
  await assert.rejects(aborted, /отменён/);
});

test('падение процесса: запрос отклоняется, супервизор поднимает новый', async (t) => {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'dsh-bridge-crash-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const marker = path.join(directory, 'crashed-once');

  const { bridge, logs } = createBridge(t, {
    mode: 'crash-once-on-create',
    env: { FAKE_DSH_MARKER_FILE: marker }
  });
  await bridge.start();

  await assert.rejects(
    bridge.request('session.create', { workspaceId: 'ws_fake' }),
    (error) => {
      assert.ok(error instanceof DshBridgeError);
      assert.match(error.message, /процесс DSH завершился/);
      return true;
    }
  );

  await waitFor(() => bridge.state === 'running', 'перезапуск процесса');
  assert.equal(bridge.processCount, 1);
  assert.ok(logs.some((line) => line.includes('перезапускаю')));

  const created = await bridge.request('session.create', { workspaceId: 'ws_fake' });
  assert.equal(created.sessionId, 'sess_fake');
});

test('во время рестарта запросы буферизуются и не теряются', async (t) => {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'dsh-bridge-buffer-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const marker = path.join(directory, 'crashed-once');

  const { bridge } = createBridge(t, {
    mode: 'crash-once-on-create',
    env: { FAKE_DSH_MARKER_FILE: marker },
    options: { initialRestartDelayMs: 200 }
  });
  await bridge.start();

  const crashed = bridge.request('session.create', { workspaceId: 'ws_fake' });
  await assert.rejects(crashed, /процесс DSH завершился/);
  await waitFor(() => bridge.state === 'restarting', 'состояние restarting');

  const buffered = bridge.request('session.list', {});
  const result = await buffered;
  assert.deepEqual(result.sessions, []);
  assert.equal(bridge.state, 'running');
});

test('start(): понятная ошибка, если процесс не поднимается', async (t) => {
  const { bridge, logs } = createBridge(t, {
    mode: 'exit-immediately',
    options: { maxRestartAttempts: 2 }
  });

  await assert.rejects(
    bridge.start(),
    (error) => {
      assert.ok(error instanceof DshBridgeError);
      assert.match(error.message, /healthcheck|завершился/);
      return true;
    }
  );
  assert.equal(bridge.state, 'failed');
  assert.equal(bridge.processCount, 0);
  assert.ok(logs.some((line) => line.includes('попытка 1/2')));
});

test('start(): healthcheck не пройден — мост не считается поднятым', async (t) => {
  const { bridge } = createBridge(t, {
    mode: 'no-ping',
    options: { maxRestartAttempts: 1, healthcheckTimeoutMs: 200 }
  });

  await assert.rejects(bridge.start(), /healthcheck DSH не пройден/);
  assert.equal(bridge.state, 'failed');
  assert.equal(bridge.processCount, 0);
});

test('stop(): graceful shutdown завершает процесс', async (t) => {
  const { bridge, logs } = createBridge(t);
  await bridge.start();

  await bridge.stop();
  assert.equal(bridge.state, 'stopped');
  assert.equal(bridge.processCount, 0);
  assert.ok(!logs.some((line) => line.includes('SIGKILL')), 'до SIGKILL доходить не должно');
});

test('stop(): SIGTERM игнорируется — супервизор эскалирует до SIGKILL', async (t) => {
  if (process.platform === 'win32') {
    t.skip('на Windows нет SIGTERM/SIGKILL в том же смысле');
    return;
  }
  const { bridge, logs } = createBridge(t, {
    mode: 'ignore-sigterm',
    options: { shutdownGraceMs: 100 }
  });
  await bridge.start();

  await bridge.stop();
  assert.equal(bridge.state, 'stopped');
  assert.equal(bridge.processCount, 0);
  assert.ok(logs.some((line) => line.includes('SIGKILL')));
});

test('stop(): снимает рестарт, запланированный после падения', async (t) => {
  const { bridge } = createBridge(t, { mode: 'crash-after-ready' });
  await bridge.start();

  await waitFor(() => bridge.state === 'restarting' || bridge.state === 'running', 'состояние после падения');
  await bridge.stop();
  assert.equal(bridge.state, 'stopped');
  assert.equal(bridge.processCount, 0);
});

test('dispose(): снимает процесс и таймеры рестарта', async (t) => {
  const { bridge } = createBridge(t, { mode: 'crash-after-ready' });
  await bridge.start();

  bridge.dispose();
  assert.equal(bridge.state, 'stopped');
  assert.equal(bridge.processCount, 0);

  await sleep(200);
  assert.equal(bridge.processCount, 0, 'после dispose новые процессы не поднимаются');
  assert.equal(bridge.state, 'stopped');
});

test('логи: stderr и не-JSON строки попадают в OutputChannel', async (t) => {
  const { bridge, logs } = createBridge(t, { mode: 'noisy' });
  await bridge.start();

  await waitFor(
    () => logs.some((line) => line.startsWith('[stderr]')) && logs.some((line) => line.includes('не-JSON')),
    'логи stderr и мусора в stdout'
  );
  assert.equal(bridge.state, 'running');
});

test('запрос до старта — понятная ошибка', async (t) => {
  const { bridge } = createBridge(t);
  assert.equal(bridge.state, 'stopped');
  await assert.rejects(bridge.request('session.list', {}), /не запущен|недоступен/);
});

test('запрос от сервера: клиент отвечает «метод не поддерживается»', async (t) => {
  const { bridge, logs } = createBridge(t, { mode: 'server-request' });
  await bridge.start();

  await waitFor(
    () => logs.some((line) => line.includes('client.do')),
    'ответ на запрос сервера'
  );
});

test('defaultDshCommand: dsh serve с cwd и sandbox', () => {
  assert.deepEqual(defaultDshCommand({ executablePath: 'dsh', cwd: '/ws' }), {
    executable: 'dsh',
    args: ['serve', '--protocol=jsonrpc', '--cwd', '/ws']
  });
  assert.deepEqual(
    defaultDshCommand({ executablePath: '/opt/dsh', cwd: '/ws', sandboxMode: 'workspace-write' }),
    {
      executable: '/opt/dsh',
      args: ['serve', '--protocol=jsonrpc', '--cwd', '/ws', '--sandbox', 'workspace-write']
    }
  );
});

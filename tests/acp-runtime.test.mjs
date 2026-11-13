import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { register } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

// acpRuntime.ts импортирует соседние модули без расширения — подставляем .ts.
register('./helpers/ts-loader.mjs', import.meta.url);
const { AcpRuntime } = await import('../extension/src/runtime/acpRuntime.ts');

const FIXTURE = path.resolve('tests/fixtures/fake-acp-runtime.mjs');
const tmpRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), 'dsh-acp-runtime-')));
after(() => rm(tmpRoot, { recursive: true, force: true }));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, { timeoutMs = 5000, label = 'условие' } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await sleep(10);
  }
  throw new Error(`не дождались: ${label}`);
}

let counter = 0;
async function harness(env = {}, options = {}) {
  counter += 1;
  const workspace = await mkdtemp(path.join(tmpRoot, `ws-${String(counter)}-`));
  const lines = [];
  const runtime = new AcpRuntime({
    workspacePath: workspace,
    executablePath: FIXTURE,
    homeDirectory: path.join(tmpRoot, 'home'),
    env: { ...process.env, ...env },
    logger: (line) => lines.push(line),
    requestTimeoutMs: 5000,
    shutdownGraceMs: 2000,
    restartInitialDelayMs: 50,
    restartMaxDelayMs: 200,
    maxRestartAttempts: 3,
    discovery: { allowNpxFallback: false },
    ...options
  });
  return { runtime, workspace, lines };
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test('ACPruntime: старт, версия, session.list/create/resume, остановка', async () => {
  const { runtime } = await harness();

  await runtime.start();
  assert.equal(runtime.state, 'running');
  assert.equal(runtime.version.acp, '9.9.9');
  assert.match(runtime.diagnostics.message, /готов/);

  const list = await runtime.request('session.list', { workspaceId: 'ws-1' });
  assert.equal(list.sessions[0].id, 'sess-existing');
  assert.equal(list.sessions[0].workspaceId, 'ws-1');

  const created = await runtime.request('session.create', { workspaceId: 'ws-1' });
  assert.match(created.sessionId, /^sess-/);

  const resumed = await runtime.request('session.resume', { sessionId: 'sess-1' });
  assert.equal(resumed.session.id, 'sess-1');

  assert.deepEqual(await runtime.request('workspace.ping', {}), {
    pong: true,
    protocolVersion: '9.9.9'
  });

  const pid = runtime.processId;
  assert.equal(typeof pid, 'number');
  await runtime.stop();
  assert.equal(runtime.state, 'stopped');
  await waitFor(() => !isAlive(pid), { label: 'процесс завершён' });
});

test('ACPruntime: turn.start превращается в токены, tool-события и turn.done', async () => {
  const { runtime } = await harness();
  await runtime.start();

  const tokens = [];
  const calls = [];
  const results = [];
  const done = [];
  runtime.on('token', (payload) => tokens.push(payload.text));
  runtime.on('tool.call', (payload) => calls.push(payload));
  runtime.on('tool.result', (payload) => results.push(payload));
  runtime.on('turn.done', (payload) => done.push(payload));

  const started = await runtime.request('turn.start', { sessionId: 'sess-1', input: 'привет' });
  assert.equal(started.sessionId, 'sess-1');
  assert.match(started.turnId, /^turn-/);

  await waitFor(() => done.length === 1, { label: 'turn.done' });
  assert.equal(tokens.join(''), 'Привет, мир!');
  assert.equal(calls[0].name, 'read_file');
  assert.deepEqual(calls[0].arguments, { path: 'README.md' });
  assert.equal(results[0].ok, true);
  assert.equal(done[0].finishReason, 'stop');
  await runtime.stop();
});

test('ACPruntime: turn.cancel — notification session/cancel, ход закрывается как cancelled', async () => {
  const logFile = path.join(tmpRoot, 'methods.log');
  const { runtime } = await harness({ FAKE_ACP_HANG_PROMPT: '1', FAKE_ACP_LOG: logFile });
  await runtime.start();

  const done = [];
  runtime.on('turn.done', (payload) => done.push(payload));

  await runtime.request('turn.start', { sessionId: 'sess-1', input: 'долго' });
  const cancelled = await runtime.request('turn.cancel', { sessionId: 'sess-1', turnId: 'turn-1' });
  assert.deepEqual(cancelled, { cancelled: true });

  await waitFor(() => done.length === 1, { label: 'cancelled turn.done' });
  assert.equal(done[0].finishReason, 'cancelled');
  await waitFor(async () => {
    try {
      const content = await readFile(logFile, 'utf8');
      return content.includes('session/cancel');
    } catch {
      return false;
    }
  }, { label: 'session/cancel в логе' });
  await runtime.stop();
});

test('ACPruntime: падение процесса — перезапуск по backoff, запросы снова работают', async () => {
  const crashFile = path.join(tmpRoot, 'crash.marker');
  const { runtime } = await harness({ FAKE_ACP_CRASH_FILE: crashFile });
  await runtime.start();

  await assert.rejects(() => runtime.request('session.list', {}), /завершился|не готов/);
  await waitFor(() => runtime.state === 'running', { label: 'рестарт рантайма' });

  const list = await runtime.request('session.list', {});
  assert.equal(list.sessions[0].id, 'sess-existing');
  await runtime.stop();
});

test('ACPruntime: рантайма нет — failed с инструкцией, extension host жив', async () => {
  const lines = [];
  const runtime = new AcpRuntime({
    workspacePath: tmpRoot,
    executablePath: path.join(tmpRoot, 'missing-dsh'),
    homeDirectory: path.join(tmpRoot, 'home'),
    logger: (line) => lines.push(line),
    discovery: { allowNpxFallback: false }
  });

  await runtime.start();
  assert.equal(runtime.state, 'failed');
  assert.match(runtime.diagnostics.message, /не найден/i);
  assert.match(runtime.diagnostics.instructions, /npm i -g @deepseek-ai\/dsh/);
  await assert.rejects(() => runtime.request('session.list', {}), /не готов/);
  await runtime.stop();
  assert.equal(runtime.state, 'failed');
});

test('ACPruntime: логи не содержат токенов', async () => {
  const { runtime, lines } = await harness({ FAKE_ACP_LOG: '' });
  await runtime.start();
  await runtime.request('session.list', {});
  await runtime.stop();
  const text = lines.join('\n');
  assert.ok(!/token=[^&\s]+/.test(text), 'токен в логе');
  assert.ok(!/Bearer\s+[A-Za-z0-9.]+/.test(text), 'bearer в логе');
});

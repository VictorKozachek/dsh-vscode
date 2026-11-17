import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { register } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

register('./helpers/ts-loader.mjs', import.meta.url);
const { DshWorkspaceRuntime, parseSandbox } = await import('../extension/src/workspace/dshRuntime.ts');
const { WorkspaceLifecycle } = await import('../extension/src/workspace/lifecycle.ts');
const { WorkspaceRegistry } = await import('../extension/src/workspace/registry.ts');

const FIXTURE = path.resolve('tests/fixtures/fake-acp-runtime.mjs');
const tmpRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), 'dsh-runtime-lifecycle-')));
after(() => rm(tmpRoot, { recursive: true, force: true }));

const memento = {
  get: () => undefined,
  update: async () => undefined
};

async function makeFolder(name) {
  const dir = await mkdtemp(path.join(tmpRoot, `${name}-`));
  return { id: name.repeat(16).slice(0, 16), path: dir };
}

function createRuntime(folder, registry, posts, extra = {}) {
  return new DshWorkspaceRuntime({
    folder,
    memento,
    registry,
    sandboxMode: 'bogus', // проверяем валидацию
    executablePath: FIXTURE,
    profile: 'acp',
    homeDirectory: tmpRoot,
    approvalPolicy: 'ask',
    log: () => undefined,
    post: (message) => {
      posts.push(message);
    },
    isActive: () => true,
    runtimeOptions: { shutdownGraceMs: 500 },
    ...extra
  });
}

test('A→B→A на реальном DshBridge: grace, processCount, teardown', async () => {
  const registry = new WorkspaceRegistry({ registryDir: path.join(tmpRoot, 'registry') });
  const folderA = await makeFolder('a');
  const folderB = await makeFolder('b');
  const postsByFolder = new Map();
  const runtimes = new Map();
  let lifecycleRef;
  const lifecycle = new WorkspaceLifecycle({
    createRuntime: async (folder) => {
      const own = [];
      postsByFolder.set(folder.id, own);
      const runtime = createRuntime(folder, registry, own, {
        isActive: () => lifecycleRef?.acceptsEvent(folder.id) ?? false
      });
      runtimes.set(folder.id, runtime);
      return runtime;
    },
    graceMs: 250,
    debounceMs: 0
  });
  lifecycleRef = lifecycle;

  try {
    await lifecycle.activate(folderA);
    const runtimeA = runtimes.get('a'.repeat(16));
    assert.equal(runtimeA.processCount, 1, 'процесс A поднят');
    const listed = await runtimeA.sessions.list();
    assert.ok(Array.isArray(listed), 'session.list через lifecycle-рантайм');
    const created = await runtimeA.sessions.create({ title: 'lifecycle' });
    assert.match(created.sessionId ?? '', /sess-/, 'session.create через lifecycle-рантайм');

    await lifecycle.activate(folderB);
    assert.equal(runtimeA.processCount, 1, 'A жив в grace');
    const postsABefore = postsByFolder.get('a'.repeat(16)).length;
    runtimeA.chat.syncNow();
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(
      postsByFolder.get('a'.repeat(16)).length,
      postsABefore,
      'старый A не постит после switch на B'
    );
    const runtimeB = runtimes.get('b'.repeat(16));
    assert.equal(runtimeB.processCount, 1, 'процесс B поднят');

    await lifecycle.activate(folderA);
    assert.equal(runtimes.get('a'.repeat(16)), runtimeA, 'A возобновлён без пересоздания');
    assert.equal(runtimeA.processCount, 1, 'процесс A не перезапускался');

    await new Promise((resolve) => setTimeout(resolve, 700));
    assert.equal(runtimeB.processCount, 0, 'B погашен после grace');

    await lifecycle.teardownAll();
    assert.equal(runtimeA.processCount, 0, 'после teardown процессов нет');
  } finally {
    await lifecycle.dispose();
    registry.dispose?.();
  }
});

test('dispose рантайма ждёт остановку моста (processCount=0)', async () => {
  const registry = new WorkspaceRegistry({ registryDir: path.join(tmpRoot, 'registry2') });
  const folder = await makeFolder('c');
  const runtime = createRuntime(folder, registry, []);
  await runtime.loadContext();
  await runtime.restoreSession();
  await runtime.dispose();
  assert.equal(runtime.processCount, 0);
});

test('sandbox валидируется: неизвестное значение → workspace-write', () => {
  assert.equal(parseSandbox('bogus'), 'workspace-write');
  assert.equal(parseSandbox(undefined), 'workspace-write');
  assert.equal(parseSandbox('read-only'), 'read-only');
  assert.equal(parseSandbox('danger-full-access'), 'danger-full-access');
});


test('lifecycle: ACP permission → ApprovalBroker → карточка и ответ ACP', async () => {
  const { readFile } = await import('node:fs/promises');
  const logFile = path.join(tmpRoot, `permission-${String(Date.now())}.log`);
  const registry = new WorkspaceRegistry({ registryDir: path.join(tmpRoot, 'registry-perm') });
  const folder = await makeFolder('perm');
  const posts = [];
  const runtime = createRuntime(folder, registry, posts, {
    approvalPolicy: 'ask',
    isActive: () => true,
    runtimeOptions: {
      shutdownGraceMs: 500,
      env: {
        ...process.env,
        FAKE_ACP_PERMISSION: '1',
        FAKE_ACP_LOG: logFile
      }
    }
  });

  await runtime.sessions.create({ title: 'perm' });
  const approvals = [];
  const originalPost = posts.push.bind(posts);
  posts.push = (message) => {
    approvals.push(message);
    return originalPost(message);
  };

  const sessionId = runtime.sessions.state.sessionId;
  const turn = await runtime.acpRuntime.request('turn.start', {
    sessionId,
    input: 'запиши'
  });
  assert.ok(turn.turnId);

  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && !approvals.some((m) => m.type === 'approvalRequest')) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const card = approvals.find((m) => m.type === 'approvalRequest');
  assert.ok(card, 'approvalRequest пришёл в UI');
  assert.equal(card.request.tool, 'write_file');

  assert.equal(runtime.approvals.resolve(card.request.id, 'allow'), true);
  const logDeadline = Date.now() + 5000;
  let text = '';
  while (Date.now() < logDeadline) {
    try {
      text = await readFile(logFile, 'utf8');
    } catch {
      text = '';
    }
    if (text.includes('response:900')) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.match(text, /response:900:.*selected/s);
  await runtime.dispose();
  registry.dispose?.();
});


test('ChatSessionsPort отдаёт model/preset в chatSession', async () => {
  const registry = new WorkspaceRegistry({ registryDir: path.join(tmpRoot, 'registry-models') });
  const folder = await makeFolder('models');
  const posts = [];
  const runtime = createRuntime(folder, registry, posts, {
    defaultModel: 'deepseek-v4',
    defaultPreset: 'worker'
  });
  try {
    await runtime.sessions.create({ title: 'm' });
    runtime.chat.syncNow();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const sessionMessage = posts.filter((message) => message.type === 'chatSession').at(-1);
    assert.ok(sessionMessage, 'chatSession отправлен');
    assert.equal(sessionMessage.session.model, 'deepseek-v4');
    assert.equal(sessionMessage.session.preset, 'worker');
  } finally {
    await runtime.dispose();
    registry.dispose?.();
  }
});

test('ACP terminal/*: агент получает вывод и код возврата; диагностика уходит session/prompt', async () => {
  const { readFile } = await import('node:fs/promises');
  const logFile = path.join(tmpRoot, `terminal-${String(Date.now())}.log`);
  const registry = new WorkspaceRegistry({ registryDir: path.join(tmpRoot, 'registry-tool') });
  const folder = await makeFolder('tool');
  const calls = [];
  const runtime = createRuntime(folder, registry, [], {
    approvalPolicy: 'auto',
    createTerminalSession: () => ({
      shellIntegrationAvailable: true,
      execute(command) {
        calls.push(command);
        return {
          async *read() {
            yield 'hi\n';
          },
          exitCode: Promise.resolve(0)
        };
      },
      dispose() {}
    }),
    collectDiagnostics: () => ({
      items: [
        { file: 'src/a.ts', severity: 'error', message: 'boom', line: 1, source: 'ts' }
      ],
      total: 1,
      truncated: false,
      bytes: 10
    }),
    runtimeOptions: {
      shutdownGraceMs: 500,
      env: {
        ...process.env,
        FAKE_ACP_TERMINAL: '1',
        FAKE_ACP_ECHO_PROMPT: '1',
        FAKE_ACP_LOG: logFile
      }
    }
  });

  try {
    await runtime.sessions.create({ title: 'tool' });
    const sessionId = runtime.sessions.state.sessionId;
    const tokens = [];
    runtime.acpRuntime.on('token', (payload) => {
      if (typeof payload.text === 'string') {
        tokens.push(payload.text);
      }
    });
    await runtime.acpRuntime.request('turn.start', { sessionId, input: 'run' });

    const deadline = Date.now() + 5000;
    let text = '';
    while (Date.now() < deadline && !text.includes('response:903')) {
      try {
        text = await readFile(logFile, 'utf8');
      } catch {
        text = '';
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.match(text, /response:901:.*"terminalId":"term-/s);
    assert.match(text, /response:902:.*hi/s);
    assert.match(text, /response:903:.*"exitCode":0/s);
    assert.deepEqual(calls, ['echo hi'], 'команда выполнена через ACP terminal/create');

    const report = await runtime.reportDiagnostics();
    assert.equal(report.total, 1);
    const echoDeadline = Date.now() + 5000;
    while (Date.now() < echoDeadline && !tokens.join('').includes('Диагностика VS Code')) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.match(tokens.join(''), /Диагностика VS Code/);
    assert.match(tokens.join(''), /src\/a\.ts:1 \[error\] boom/);
  } finally {
    await runtime.dispose();
    registry.dispose?.();
  }
});

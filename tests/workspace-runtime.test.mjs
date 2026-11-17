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

function createRuntime(folder, registry, posts) {
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
    runtimeOptions: { shutdownGraceMs: 500 }
  });
}

test('A→B→A на реальном DshBridge: grace, processCount, teardown', async () => {
  const registry = new WorkspaceRegistry({ registryDir: path.join(tmpRoot, 'registry') });
  const folderA = await makeFolder('a');
  const folderB = await makeFolder('b');
  const posts = [];
  const runtimes = new Map();
  const lifecycle = new WorkspaceLifecycle({
    createRuntime: async (folder) => {
      const runtime = createRuntime(folder, registry, posts);
      runtimes.set(folder.id, runtime);
      return runtime;
    },
    graceMs: 250,
    debounceMs: 0
  });

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

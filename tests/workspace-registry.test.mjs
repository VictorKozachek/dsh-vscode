import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

import {
  DEFAULT_KEEP_DAYS,
  PRUNE_WORKSPACES_COMMAND,
  REGISTRY_SCHEMA_VERSION,
  WorkspaceRegistry,
  WorkspaceRegistryError,
  defaultRegistryDirectory,
  stripCredentials
} from '../extension/src/workspace/registry.ts';

const tmpRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), 'dsh-workspace-registry-')));
after(() => rm(tmpRoot, { recursive: true, force: true }));

const NOW = new Date('2026-11-09T12:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;

let caseCounter = 0;

function caseDir(name) {
  caseCounter += 1;
  return path.join(tmpRoot, `${String(caseCounter).padStart(2, '0')}-${name}`);
}

/** `id` воркспейса: 16 hex-символов, как у WorkspaceResolver. */
function workspaceId(value) {
  return value.toString(16).padStart(16, '0');
}

function makeRegistry(directory, options = {}) {
  return new WorkspaceRegistry({ registryDir: directory, now: () => NOW, ...options });
}

test('реестр: чтение отсутствующей записи возвращает null', async () => {
  const registry = makeRegistry(caseDir('empty'));
  assert.equal(await registry.read(workspaceId(1)), null);
  assert.deepEqual(await registry.list(), []);
});

test('реестр: запись и чтение по схеме §4.2', async () => {
  const directory = caseDir('roundtrip');
  const registry = makeRegistry(directory);
  const id = workspaceId(2);

  const saved = await registry.save({
    id,
    path: '/Users/victor/projects/api-service',
    name: 'api-service',
    remote: 'ssh',
    gitRemote: 'github.com/acme/api-service',
    lastSessionId: 'sess_01J',
    defaultModel: 'deepseek-chat',
    sandboxMode: 'workspace-write',
    approvalPolicy: 'ask',
    contextSnapshot: { hash: 'sha256:abc', skills: ['kanban'], rules: ['AGENTS.md'], files: 1287 }
  });

  assert.equal(saved.version, REGISTRY_SCHEMA_VERSION);
  assert.equal(saved.lastOpenedAt, NOW.toISOString());

  const read = await registry.read(id);
  assert.deepEqual(read, saved);
  assert.equal(read?.gitRemote, 'github.com/acme/api-service');

  const file = registry.filePath(id);
  assert.equal(path.basename(file), `${id}.json`);
  const mode = (await stat(file)).mode & 0o777;
  assert.equal(mode, 0o600, 'файл реестра должен быть доступен только владельцу');
});

test('реестр: конкурентная запись не ломает файл', async () => {
  const directory = caseDir('concurrent');
  const registry = makeRegistry(directory);
  const id = workspaceId(3);

  await Promise.all(
    Array.from({ length: 24 }, (_, index) =>
      registry.save({ id, path: `/Users/victor/projects/app-${String(index)}`, lastSessionId: `sess_${String(index)}` })
    )
  );

  const record = await registry.read(id);
  assert.ok(record, 'после конкурентных записей запись должна читаться');
  assert.match(record.lastSessionId, /^sess_\d+$/);

  const entries = await readdir(directory);
  assert.deepEqual(entries, [`${id}.json`], 'временные файлы не должны оставаться');
});

test('реестр: битый JSON уходит в карантин, запись читается заново', async () => {
  const directory = caseDir('corrupt');
  const registry = makeRegistry(directory);
  const id = workspaceId(4);
  await mkdir(directory, { recursive: true });
  await writeFile(registry.filePath(id), '{ "id": "broken"', 'utf8');

  assert.equal(await registry.read(id), null);

  const entries = await readdir(directory);
  assert.equal(entries.length, 1);
  assert.match(entries[0], new RegExp(`^${id}\\.json\\.corrupt-\\d+$`));
  assert.equal(entries[0], `${id}.json.corrupt-${String(NOW.getTime())}`);

  const recreated = await registry.save({ id, path: '/Users/victor/projects/recovered' });
  assert.equal(recreated.path, '/Users/victor/projects/recovered');
  assert.ok(await registry.read(id));
});

test('реестр: файл более новой версии схемы не читается и не портится', async () => {
  const directory = caseDir('future');
  const registry = makeRegistry(directory);
  const id = workspaceId(5);
  await mkdir(directory, { recursive: true });

  const future = {
    version: REGISTRY_SCHEMA_VERSION + 1,
    id,
    path: '/Users/victor/projects/future',
    lastOpenedAt: NOW.toISOString(),
    somethingNew: true
  };
  await writeFile(registry.filePath(id), JSON.stringify(future), 'utf8');

  assert.equal(await registry.read(id), null);
  assert.deepEqual(await readdir(directory), [`${id}.json`], 'файл не должен уходить в карантин');
});

test('реестр: миграция v1 → текущая схема при чтении', async () => {
  const directory = caseDir('migration');
  const registry = makeRegistry(directory);
  const id = workspaceId(6);
  await mkdir(directory, { recursive: true });

  const legacy = {
    id,
    path: '/Users/victor/projects/legacy',
    name: 'legacy',
    lastOpenedAt: Date.parse('2026-01-02T03:04:05.000Z')
  };
  await writeFile(registry.filePath(id), JSON.stringify(legacy), 'utf8');

  const record = await registry.read(id);
  assert.ok(record);
  assert.equal(record.version, REGISTRY_SCHEMA_VERSION);
  assert.equal(record.lastOpenedAt, '2026-01-02T03:04:05.000Z');
  assert.equal(record.remote, 'local');
  assert.equal(record.gitRemote, null);
  assert.equal(record.contextSnapshot, null);
});

test('реестр: GC удаляет записи, не открывавшиеся keepDays дней', async () => {
  const directory = caseDir('gc');
  const registry = makeRegistry(directory, { keepDays: 30 });
  const oldId = workspaceId(7);
  const freshId = workspaceId(8);

  await registry.save({
    id: oldId,
    path: '/Users/victor/projects/old',
    lastOpenedAt: new Date(NOW.getTime() - 100 * DAY_MS).toISOString()
  });
  await registry.save({
    id: freshId,
    path: '/Users/victor/projects/fresh',
    lastOpenedAt: new Date(NOW.getTime() - 10 * DAY_MS).toISOString()
  });

  assert.deepEqual(await registry.prune(), [oldId]);
  assert.equal(await registry.read(oldId), null);
  assert.ok(await registry.read(freshId));

  assert.deepEqual(await registry.prune(), [], 'повторный GC ничего не удаляет');
  await assert.rejects(registry.prune(-1), WorkspaceRegistryError);
});

test('реестр: нет прав на запись — понятная ошибка без падения', async () => {
  const directory = caseDir('read-only');
  await mkdir(directory, { recursive: true });
  await chmod(directory, 0o500);

  try {
    const registry = makeRegistry(directory);
    await assert.rejects(
      () => registry.save({ id: workspaceId(9), path: '/Users/victor/projects/locked' }),
      (error) => {
        assert.ok(error instanceof WorkspaceRegistryError);
        assert.match(error.message, /не удалось записать запись реестра/);
        assert.match(error.message, /read-only/);
        return true;
      }
    );
  } finally {
    await chmod(directory, 0o700);
  }
});

test('реестр: секреты не попадают в файл', async () => {
  const directory = caseDir('secrets');
  const registry = makeRegistry(directory);
  const id = workspaceId(10);

  await registry.save({
    id,
    path: '/Users/victor/projects/secret-app',
    // Лишние поля и секретные ключи в любом регистре — не должны попасть на диск.
    token: 'top-secret-token',
    accessToken: 'top-secret-access',
    contextSnapshot: {
      hash: 'sha256:abc',
      skills: ['kanban'],
      rules: ['AGENTS.md'],
      files: 12,
      apiToken: 'snapshot-token',
      nested: { password: 'nested-password', clientSecret: 'nested-secret' }
    },
    gitRemote: 'https://user:token@github.com/acme/api-service.git'
  });

  const text = await readFile(registry.filePath(id), 'utf8');
  for (const secret of ['top-secret-token', 'top-secret-access', 'snapshot-token', 'nested-password', 'nested-secret', 'user:token']) {
    assert.ok(!text.includes(secret), `в реестре не должно быть секрета: ${secret}`);
  }
  assert.match(text, /github\.com\/acme\/api-service/);
  assert.equal((await registry.read(id))?.gitRemote, 'https://github.com/acme/api-service.git');
});

test('реестр: id проверяется — выход за пределы каталога невозможен', async () => {
  const registry = makeRegistry(caseDir('id-check'));
  await assert.rejects(
    () => registry.save({ id: '../../etc/passwd', path: '/tmp' }),
    WorkspaceRegistryError
  );
  await assert.rejects(() => registry.read('not-an-id'), WorkspaceRegistryError);
});

test('реестр: каталог по умолчанию — из HOME, путь с ~ раскрывается', async () => {
  const home = caseDir('home');
  await mkdir(home, { recursive: true });
  const originalHome = process.env['HOME'];

  try {
    process.env['HOME'] = home;
    assert.equal(new WorkspaceRegistry().directory, defaultRegistryDirectory(home));
    assert.equal(new WorkspaceRegistry().directory, path.join(home, '.dsh', 'workspaces'));

    const registry = new WorkspaceRegistry();
    await registry.save({ id: workspaceId(11), path: '/Users/victor/projects/home-app' });
    assert.ok(await registry.read(workspaceId(11)));

    assert.equal(new WorkspaceRegistry({ registryDir: '~/custom' }).directory, path.join(home, 'custom'));
  } finally {
    if (originalHome === undefined) {
      delete process.env['HOME'];
    } else {
      process.env['HOME'] = originalHome;
    }
  }
});

test('реестр: список отсортирован по последнему открытию', async () => {
  const directory = caseDir('list');
  const registry = makeRegistry(directory);

  await registry.save({ id: workspaceId(12), path: '/a', lastOpenedAt: '2026-11-01T00:00:00.000Z' });
  await registry.save({ id: workspaceId(13), path: '/b', lastOpenedAt: '2026-11-09T00:00:00.000Z' });
  await registry.save({ id: workspaceId(14), path: '/c', lastOpenedAt: '2026-11-05T00:00:00.000Z' });

  assert.deepEqual(
    (await registry.list()).map((record) => record.id),
    [workspaceId(13), workspaceId(14), workspaceId(12)]
  );
});

test('реестр: touch обновляет время открытия, remember сохраняет поля', async () => {
  const directory = caseDir('touch');
  const registry = makeRegistry(directory);
  const id = workspaceId(15);

  await registry.save({
    id,
    path: '/Users/victor/projects/remember',
    name: 'remember',
    lastSessionId: 'sess_42',
    lastOpenedAt: '2026-01-01T00:00:00.000Z'
  });

  const touched = await registry.touch(id);
  assert.equal(touched?.lastOpenedAt, NOW.toISOString());

  const remembered = await registry.remember({ id, path: '/Users/victor/projects/remember', name: 'renamed' });
  assert.equal(remembered.name, 'renamed');
  assert.equal(remembered.lastSessionId, 'sess_42', 'прошлые поля сохраняются');
  assert.equal(await registry.touch(workspaceId(99)), null);
});

test('реестр: remove и константы', async () => {
  const directory = caseDir('remove');
  const registry = makeRegistry(directory);
  const id = workspaceId(16);

  await registry.save({ id, path: '/Users/victor/projects/remove' });
  assert.equal(await registry.remove(id), true);
  assert.equal(await registry.remove(id), false);

  assert.equal(PRUNE_WORKSPACES_COMMAND, 'dsh.pruneWorkspaces');
  assert.equal(DEFAULT_KEEP_DAYS, 90);
  assert.equal(REGISTRY_SCHEMA_VERSION, 2);
  assert.equal(stripCredentials('https://user:pass@example.com/x'), 'https://example.com/x');
});

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

import {
  DiffService,
  DiffServiceError,
  computeLineEdits,
  createNodeDiffFileSystem,
  hashContent
} from '../extension/src/diff/diffService.ts';

const tmpRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), 'dsh-diff-service-')));
after(() => rm(tmpRoot, { recursive: true, force: true }));

let counter = 0;
async function makeWorkspace(files = {}) {
  counter += 1;
  const root = path.join(tmpRoot, `ws-${String(counter)}`);
  await mkdir(root, { recursive: true });
  for (const [relative, content] of Object.entries(files)) {
    const absolute = path.join(root, relative);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, content);
  }
  return root;
}

function service(root, fs = createNodeDiffFileSystem()) {
  return new DiffService({ workspaceRoot: root, fs, now: () => new Date('2026-11-09T12:00:00.000Z') });
}

test('предпросмотр не меняет файл, применение записывает, откат возвращает исходное', async () => {
  const root = await makeWorkspace({ 'src/app.ts': 'const a = 1;\n' });
  const diff = service(root);

  const preview = await diff.preview([
    { path: 'src/app.ts', operations: [{ kind: 'replaceFile', content: 'const a = 2;\n' }] }
  ]);

  assert.equal(preview.files.length, 1);
  assert.equal(preview.files[0].relativePath, 'src/app.ts');
  assert.equal(preview.files[0].newContent, 'const a = 2;\n');
  assert.equal(await readFile(path.join(root, 'src/app.ts'), 'utf8'), 'const a = 1;\n', 'файл не изменён до применения');

  const applied = await diff.apply(preview.id);
  assert.deepEqual(applied, { status: 'applied', files: ['src/app.ts'] });
  assert.equal(await readFile(path.join(root, 'src/app.ts'), 'utf8'), 'const a = 2;\n');
  assert.equal(diff.canRevert, true);

  const reverted = await diff.revertLast();
  assert.deepEqual(reverted, { status: 'reverted', files: ['src/app.ts'] });
  assert.equal(await readFile(path.join(root, 'src/app.ts'), 'utf8'), 'const a = 1;\n');
  assert.equal(diff.canRevert, false);
  assert.deepEqual(await diff.revertLast(), { status: 'empty' });
});

test('точечные правки: replaceText и replaceLines', async () => {
  const root = await makeWorkspace({ 'a.txt': 'one\ntwo\nthree\n' });
  const diff = service(root);

  const preview = await diff.preview([
    {
      path: 'a.txt',
      operations: [
        { kind: 'replaceText', find: 'two', replace: 'TWO' },
        { kind: 'replaceLines', startLine: 3, endLine: 3, lines: ['three!'] }
      ]
    }
  ]);

  assert.equal(preview.files[0].newContent, 'one\nTWO\nthree!\n');
  assert.deepEqual(preview.files[0].textEdits, [
    { startLine: 2, endLine: 3, replacement: 'TWO\nthree!' }
  ]);
  await diff.apply();
  assert.equal(await readFile(path.join(root, 'a.txt'), 'utf8'), 'one\nTWO\nthree!\n');
});

test('точечная правка: неоднозначный и отсутствующий фрагмент — понятные ошибки', async () => {
  const root = await makeWorkspace({ 'a.txt': 'x x x\n' });
  const diff = service(root);

  await assert.rejects(
    () => diff.preview([{ path: 'a.txt', operations: [{ kind: 'replaceText', find: 'x', replace: 'y' }] }]),
    (error) => {
      assert.ok(error instanceof DiffServiceError);
      assert.equal(error.code, 'ambiguous-match');
      return true;
    }
  );

  const all = await diff.preview([
    { path: 'a.txt', operations: [{ kind: 'replaceText', find: 'x', replace: 'y', all: true }] }
  ]);
  assert.equal(all.files[0].newContent, 'y y y\n');

  await assert.rejects(
    () => diff.preview([{ path: 'a.txt', operations: [{ kind: 'replaceText', find: 'zzz', replace: 'y' }] }]),
    (error) => error instanceof DiffServiceError && error.code === 'not-found'
  );
});

test('конфликт версий: файл изменился после предпросмотра — ничего не затираем', async () => {
  const root = await makeWorkspace({ 'src/app.ts': 'v1\n' });
  const diff = service(root);

  const preview = await diff.preview([
    { path: 'src/app.ts', operations: [{ kind: 'replaceFile', content: 'v2\n' }] }
  ]);

  await writeFile(path.join(root, 'src/app.ts'), 'v1 + чужие изменения\n');
  const result = await diff.apply(preview.id);

  assert.deepEqual(result, { status: 'conflict', path: 'src/app.ts' });
  assert.equal(
    await readFile(path.join(root, 'src/app.ts'), 'utf8'),
    'v1 + чужие изменения\n',
    'чужие изменения сохранены'
  );
  assert.equal(diff.canRevert, false);
});

test('правка вне корня воркспейса отклоняется', async () => {
  const root = await makeWorkspace({ 'src/app.ts': 'x\n' });
  const diff = service(root);

  for (const outside of ['../outside.ts', path.join(tmpRoot, 'outside.ts'), '/etc/passwd']) {
    await assert.rejects(
      () => diff.preview([{ path: outside, operations: [{ kind: 'replaceFile', content: 'hack' }] }]),
      (error) => {
        assert.ok(error instanceof DiffServiceError);
        assert.equal(error.code, 'outside-workspace');
        return true;
      }
    );
  }
});

test('симлинк наружу из воркспейса не обходит границы', async () => {
  const root = await makeWorkspace({ 'src/app.ts': 'x\n' });
  const outsideDir = path.join(tmpRoot, `outside-${String(counter)}`);
  await mkdir(outsideDir, { recursive: true });
  const { symlink } = await import('node:fs/promises');
  await symlink(outsideDir, path.join(root, 'link-out'), 'dir');

  const diff = service(root);
  await assert.rejects(
    () => diff.preview([{ path: 'link-out/secret.ts', operations: [{ kind: 'replaceFile', content: 'x' }] }]),
    (error) => error instanceof DiffServiceError && error.code === 'outside-workspace'
  );
});

test('ошибка записи откатывает уже записанные файлы транзакции', async () => {
  const root = await makeWorkspace({ 'a.txt': 'A\n', 'b.txt': 'B\n' });
  const baseFs = createNodeDiffFileSystem();
  let writes = 0;
  const flakyFs = {
    ...baseFs,
    async writeFile(filePath, content) {
      writes += 1;
      if (writes === 2) {
        throw new Error('disk full');
      }
      await baseFs.writeFile(filePath, content);
    }
  };
  const diff = service(root, flakyFs);

  await diff.preview([
    { path: 'a.txt', operations: [{ kind: 'replaceFile', content: 'A2\n' }] },
    { path: 'b.txt', operations: [{ kind: 'replaceFile', content: 'B2\n' }] }
  ]);

  const result = await diff.apply();
  assert.equal(result.status, 'failed');
  assert.equal(await readFile(path.join(root, 'a.txt'), 'utf8'), 'A\n', 'первый файл откатан');
  assert.equal(await readFile(path.join(root, 'b.txt'), 'utf8'), 'B\n');
});

test('откат после чужих правок — конфликт', async () => {
  const root = await makeWorkspace({ 'a.txt': 'v1\n' });
  const diff = service(root);

  const preview = await diff.preview([
    { path: 'a.txt', operations: [{ kind: 'replaceFile', content: 'v2\n' }] }
  ]);
  await diff.apply(preview.id);
  await writeFile(path.join(root, 'a.txt'), 'v2 + правка пользователя\n');

  const reverted = await diff.revertLast();
  assert.deepEqual(reverted, { status: 'conflict', path: 'a.txt' });
  assert.equal(await readFile(path.join(root, 'a.txt'), 'utf8'), 'v2 + правка пользователя\n');
});

test('новый файл создаётся и удаляется откатом', async () => {
  const root = await makeWorkspace({});
  const diff = service(root);

  const preview = await diff.preview([
    { path: 'new/created.ts', operations: [{ kind: 'replaceFile', content: 'export {};\n' }] }
  ]);
  assert.equal(preview.files[0].created, true);

  await diff.apply();
  assert.equal(await readFile(path.join(root, 'new/created.ts'), 'utf8'), 'export {};\n');

  await diff.revertLast();
  await assert.rejects(() => readFile(path.join(root, 'new/created.ts'), 'utf8'));
});

test('computeLineEdits: минимальная строчная замена и её отсутствие', () => {
  assert.deepEqual(computeLineEdits('a\nb\nc\n', 'a\nB\nc\n'), [
    { startLine: 2, endLine: 2, replacement: 'B' }
  ]);
  assert.deepEqual(computeLineEdits('a\n', 'a\nb\n'), [
    { startLine: 2, endLine: 1, replacement: 'b' }
  ]);
  assert.deepEqual(computeLineEdits('a\nb\n', 'a\nb\n'), []);
  assert.deepEqual(computeLineEdits('a\nb\n', ''), [{ startLine: 1, endLine: 2, replacement: '' }]);
});

test('hashContent стабилен и различает содержимое', () => {
  assert.equal(hashContent('abc'), hashContent('abc'));
  assert.notEqual(hashContent('abc'), hashContent('abcd'));
  assert.equal(hashContent('abc').length, 64);
});

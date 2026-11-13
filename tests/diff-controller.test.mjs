import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { register } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

register('./helpers/ts-loader.mjs', import.meta.url);
const { DiffController } = await import('../extension/src/diff/diffController.ts');
const { DiffService } = await import('../extension/src/diff/diffService.ts');

const tmpRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), 'dsh-diff-controller-')));
after(() => rm(tmpRoot, { recursive: true, force: true }));

let counter = 0;
async function workspace(files = {}) {
  counter += 1;
  const root = path.join(tmpRoot, `ws-${String(counter)}`);
  await mkdir(root, { recursive: true });
  for (const [relative, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await writeFile(path.join(root, relative), content);
  }
  return root;
}

/** Фейковый редактор: пишет файл и держит undo-стек. */
function createEditor({ corrupt = false } = {}) {
  const shown = [];
  const errors = [];
  const infos = [];
  const stack = [];
  const applied = [];
  return {
    shown,
    errors,
    infos,
    stack,
    applied,
    async showDiff(files) {
      shown.push(...files);
    },
    async applyContent(file) {
      applied.push(file);
      let previous = null;
      try {
        previous = await readFile(file.path, 'utf8');
      } catch {
        previous = null;
      }
      const content = corrupt ? `${file.content}ПОВРЕЖДЕНО` : file.content;
      await mkdir(path.dirname(file.path), { recursive: true });
      await writeFile(file.path, content);
      stack.push({ path: file.path, previous });
      return true;
    },
    clearPreviews() {},
    showError(message) {
      errors.push(message);
    },
    showInfo(message) {
      infos.push(message);
    },
    async undo() {
      const entry = stack.pop();
      if (entry === undefined) {
        return;
      }
      if (entry.previous === null) {
        await rm(entry.path, { force: true });
      } else {
        await writeFile(entry.path, entry.previous);
      }
    }
  };
}

function makeController(root, editor) {
  const service = new DiffService({ workspaceRoot: root });
  return { controller: new DiffController(service, editor), service };
}

test('предпросмотр показывает diff и не меняет файл', async () => {
  const root = await workspace({ 'a.txt': 'a\n' });
  const editor = createEditor();
  const { controller } = makeController(root, editor);

  const preview = await controller.preview([
    { path: 'a.txt', operations: [{ kind: 'replaceFile', content: 'a\nb\n' }] }
  ]);

  assert.equal(editor.shown.length, 1);
  assert.equal(editor.shown[0].newContent, 'a\nb\n');
  assert.equal(await readFile(path.join(root, 'a.txt'), 'utf8'), 'a\n');
  assert.equal(preview.files[0].newContent, 'a\nb\n');
});

test('применение точного содержимого и undo возвращают исходное', async () => {
  const cases = [
    { before: 'a', after: 'a\n' },
    { before: 'a', after: 'a\nb' },
    { before: 'a\n', after: 'a\nb\n' },
    { before: 'a\n', after: 'a' },
    { before: 'a\r\nb\r\n', after: 'a\r\nb\r\nc\r\n' }
  ];

  for (const item of cases) {
    const root = await workspace({ 'f.txt': item.before });
    const editor = createEditor();
    const { controller } = makeController(root, editor);

    await controller.preview([
      { path: 'f.txt', operations: [{ kind: 'replaceFile', content: item.after }] }
    ]);
    const result = await controller.apply();
    assert.equal(result, 'applied', `${JSON.stringify(item)}: apply`);
    assert.equal(
      await readFile(path.join(root, 'f.txt'), 'utf8'),
      item.after,
      `${JSON.stringify(item)}: точное содержимое`
    );

    await editor.undo();
    assert.equal(
      await readFile(path.join(root, 'f.txt'), 'utf8'),
      item.before,
      `${JSON.stringify(item)}: undo`
    );
  }
});

test('расхождение фактического содержимого не помечает транзакцию применённой', async () => {
  const root = await workspace({ 'a.txt': 'a\n' });
  const editor = createEditor({ corrupt: true });
  const { controller, service } = makeController(root, editor);

  await controller.preview([
    { path: 'a.txt', operations: [{ kind: 'replaceFile', content: 'b\n' }] }
  ]);
  const result = await controller.apply();

  assert.equal(result, 'conflict');
  assert.equal(service.canRevert, false);
  assert.ok(editor.errors.some((message) => message.includes('не совпало')));
});

test('конфликт версий отменяет применение до записи', async () => {
  const root = await workspace({ 'a.txt': 'v1\n' });
  const editor = createEditor();
  const { controller } = makeController(root, editor);

  await controller.preview([
    { path: 'a.txt', operations: [{ kind: 'replaceFile', content: 'v2\n' }] }
  ]);
  await writeFile(path.join(root, 'a.txt'), 'чужие изменения\n');

  assert.equal(await controller.apply(), 'conflict');
  assert.equal(editor.applied.length, 0, 'редактор не трогали');
  assert.equal(await readFile(path.join(root, 'a.txt'), 'utf8'), 'чужие изменения\n');
});

test('Revert Last Edit через контроллер возвращает исходное', async () => {
  const root = await workspace({ 'a.txt': 'old\n' });
  const editor = createEditor();
  const { controller } = makeController(root, editor);

  await controller.preview([
    { path: 'a.txt', operations: [{ kind: 'replaceFile', content: 'new\n' }] }
  ]);
  await controller.apply();
  await controller.revertLastEdit();

  assert.equal(await readFile(path.join(root, 'a.txt'), 'utf8'), 'old\n');
  assert.ok(editor.infos.some((message) => message.includes('откачены')));
});

test('устаревший preview id не применяется', async () => {
  const root = await workspace({ 'a.txt': 'a\n' });
  const editor = createEditor();
  const { controller } = makeController(root, editor);

  await controller.preview([
    { path: 'a.txt', operations: [{ kind: 'replaceFile', content: 'b\n' }] }
  ]);
  assert.equal(await controller.apply('preview-999'), 'stale');
  assert.equal(await readFile(path.join(root, 'a.txt'), 'utf8'), 'a\n');
});

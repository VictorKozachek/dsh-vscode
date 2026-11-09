import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bundlePath = path.join(repoRoot, 'extension', 'dist', 'extension.js');

const bundle = await readFile(bundlePath, 'utf8');

test('сборка extension host: один файл, а не набор модулей', () => {
  assert.ok(bundle.length > 0, 'extension/dist/extension.js пуст');
  assert.match(bundle, /module\.exports/, 'бандл должен быть CommonJS-модулем');
});

test('сборка extension host: пакеты workspace вкомпилированы', () => {
  assert.doesNotMatch(
    bundle,
    /require\(["']@dsh-vscode\//,
    'внешний require на пакет workspace — бандл не собрал его внутрь'
  );
  assert.doesNotMatch(bundle, /require\(["']react(-dom)?["']\)/, 'React не должен попадать в extension host');
});

test('сборка extension host: снаружи остаётся только vscode', () => {
  const required = [...bundle.matchAll(/require\(["']([^"']+)["']\)/g)].map((match) => match[1]);
  const external = [...new Set(required)].filter(
    (name) => name !== 'vscode' && !name.startsWith('node:')
  );
  assert.deepEqual(external, [], `неожиданные внешние зависимости: ${external.join(', ')}`);
});

test('сборка extension host: точка входа активации на месте', () => {
  assert.match(bundle, /activate/);
  assert.match(bundle, /deactivate/);
});

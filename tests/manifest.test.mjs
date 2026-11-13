import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const extensionRoot = path.join(repoRoot, 'extension');

const manifest = JSON.parse(
  await readFile(path.join(extensionRoot, 'package.json'), 'utf8')
);

/** Команды из §10 спецификации: id → отображаемый заголовок (category + title). */
const expectedCommands = {
  'dsh.newSession': 'DSH: New Session',
  'dsh.switchWorkspace': 'DSH: Switch Workspace',
  'dsh.reloadContext': 'DSH: Reload Context',
  'dsh.openTaskBoard': 'DSH: Open Task Board',
  'dsh.stopAgent': 'DSH: Stop Agent',
  'dsh.showContextInspector': 'DSH: Show Context Inspector',
  'dsh.resumeLastSession': 'DSH: Resume Last Session',
  'dsh.openSettings': 'DSH: Open Settings'
};

/**
 * Служебные команды вне §10 (добавляются задачами по мере надобности):
 * id → заголовок. Сейчас — GC реестра воркспейсов (#003).
 */
const extraCommands = {
  'dsh.pruneWorkspaces': 'DSH: Prune Workspaces'
};

/** Настройки из §9 спецификации: ключ → тип и значение по умолчанию. */
const expectedSettings = {
  'dsh.executablePath': { type: 'string', default: 'dsh' },
  'dsh.autoStart': { type: 'boolean', default: true },
  'dsh.defaultModel': { type: 'string', default: 'deepseek-chat' },
  'dsh.sandboxMode': {
    type: 'string',
    default: 'workspace-write',
    values: ['read-only', 'workspace-write', 'danger-full-access']
  },
  'dsh.approvalPolicy': {
    type: 'string',
    default: 'ask',
    values: ['ask', 'auto', 'never']
  },
  'dsh.context.autoReload': { type: 'boolean', default: true },
  'dsh.context.maxBytes': { type: 'number', default: 262144 },
  'dsh.workspace.registryPath': { type: 'string', default: '~/.dsh/workspaces' },
  // Не из §9: срок хранения записей реестра воркспейсов (#003), 90 дней.
  'dsh.workspace.keepDays': { type: 'number', default: 90 },
  // Не из §9: grace period смены папки (#011), 10 минут.
  'dsh.workspace.graceMinutes': { type: 'number', default: 10 },
  'dsh.kanban.enabled': { type: 'boolean', default: false },
  'dsh.telemetry.enabled': { type: 'boolean', default: false }
};

test('манифест: обязательные поля расширения', () => {
  assert.equal(manifest.name, 'dsh-vscode');
  assert.equal(typeof manifest.publisher, 'string');
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.equal(manifest.main, './dist/extension.js');
  assert.match(manifest.engines.vscode, /^\^\d+\.\d+\.\d+$/);
  assert.deepEqual(manifest.activationEvents, ['onStartupFinished']);
});

test('манифест: @types/vscode не новее engines.vscode', () => {
  // vsce отвергает пакет, если типы новее заявленного движка.
  const typesRange = manifest.devDependencies['@types/vscode'];
  assert.ok(typesRange, 'в devDependencies должен быть @types/vscode');
  const version = (range) => range.replace(/^[~^]/, '');
  assert.equal(version(typesRange), version(manifest.engines.vscode));
});

test('манифест: команды соответствуют §10 спецификации', () => {
  const commands = manifest.contributes.commands;
  const actual = Object.fromEntries(
    commands.map((command) => [command.command, `${command.category}: ${command.title}`])
  );

  // Все команды §10 на месте с правильными заголовками.
  for (const [id, title] of Object.entries(expectedCommands)) {
    assert.equal(actual[id], title, `команда ${id}`);
  }
  // Сверх §10 допустимы только известные служебные команды.
  for (const [id, title] of Object.entries(actual)) {
    if (!(id in expectedCommands)) {
      assert.equal(title, extraCommands[id], `неизвестная команда ${id}`);
    }
  }
  assert.equal(
    commands.length,
    Object.keys(expectedCommands).length + Object.keys(extraCommands).length,
    'лишние команды должны быть перечислены в extraCommands'
  );
});

test('манифест: настройки соответствуют §9 спецификации', () => {
  const properties = manifest.contributes.configuration.properties;

  assert.deepEqual(Object.keys(properties).sort(), Object.keys(expectedSettings).sort());
  for (const [key, expected] of Object.entries(expectedSettings)) {
    const property = properties[key];
    assert.equal(property.type, expected.type, `${key}: тип`);
    assert.deepEqual(property.default, expected.default, `${key}: значение по умолчанию`);
    if (expected.values !== undefined) {
      assert.deepEqual(property.enum, expected.values, `${key}: допустимые значения`);
    }
  }
});

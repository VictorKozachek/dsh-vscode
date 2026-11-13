import assert from 'node:assert/strict';
import test from 'node:test';

import {
  APPROVAL_OPTIONS,
  MAX_TITLE_LENGTH,
  REMEMBERED_KEY,
  SANDBOX_OPTIONS,
  STANDARD_PRESET,
  buildCreateOptions,
  buildNewSessionValues,
  coerceApproval,
  coerceSandbox,
  defaultSessionTitle,
  hasErrors,
  mergeModels,
  mergePresets,
  rememberedFromValues,
  validateNewSession
} from '../extension/src/views/newSessionModel.ts';

const NOW = new Date(2026, 10, 13, 22, 30);

const PRESETS = mergePresets([
  { id: 'worker', title: 'worker', description: 'Исполнитель' },
  { id: 'standard', title: 'duplicate standard' }
]);

function values(overrides = {}) {
  return {
    preset: 'standard',
    model: 'deepseek-chat',
    sandbox: 'workspace-write',
    approval: 'ask',
    title: '',
    confirmDanger: false,
    ...overrides
  };
}

test('значения по умолчанию: настройки, затем последние использованные', () => {
  const defaults = buildNewSessionValues({
    settings: { defaultModel: 'deepseek-v4', sandboxMode: 'read-only', approvalPolicy: 'auto' },
    remembered: {}
  });
  assert.equal(defaults.model, 'deepseek-v4');
  assert.equal(defaults.sandbox, 'read-only');
  assert.equal(defaults.approval, 'auto');
  assert.equal(defaults.preset, 'standard');

  const remembered = buildNewSessionValues({
    settings: { defaultModel: 'deepseek-v4', sandboxMode: 'read-only', approvalPolicy: 'auto' },
    remembered: { preset: 'worker', model: 'custom-model', sandbox: 'workspace-write', approval: 'never' }
  });
  assert.equal(remembered.preset, 'worker');
  assert.equal(remembered.model, 'custom-model');
  assert.equal(remembered.sandbox, 'workspace-write');
  assert.equal(remembered.approval, 'never');
});

test('нормализация sandbox/approval и стандартный пресет', () => {
  assert.equal(coerceSandbox('danger-full-access'), 'danger-full-access');
  assert.equal(coerceSandbox('nope'), 'workspace-write');
  assert.equal(coerceApproval('never'), 'never');
  assert.equal(coerceApproval(undefined), 'ask');
  assert.deepEqual(SANDBOX_OPTIONS, ['read-only', 'workspace-write', 'danger-full-access']);
  assert.deepEqual(APPROVAL_OPTIONS, ['ask', 'auto', 'never']);

  assert.deepEqual(mergePresets([]), [STANDARD_PRESET]);
  assert.deepEqual(PRESETS.map((preset) => preset.id), ['standard', 'worker']);
  assert.equal(PRESETS[0].title, 'standard', 'стандартный пресет идёт первым');
});

test('модели: дефолт первым, дубли и пустые убираются', () => {
  assert.deepEqual(mergeModels(['a', 'b', 'a', ' '], 'b'), ['b', 'a']);
  assert.deepEqual(mergeModels([], undefined), []);
  assert.deepEqual(mergeModels(['x'], undefined), ['x']);
});

test('валидация: пустые/недопустимые значения блокируют создание', () => {
  const options = { presets: PRESETS, models: ['deepseek-chat', 'other'] };

  assert.equal(hasErrors(validateNewSession(values(), options)), false);

  assert.equal(validateNewSession(values({ preset: '' }), options).preset, 'Выберите пресет');
  assert.match(
    validateNewSession(values({ preset: 'missing' }), options).preset,
    /Неизвестный пресет/
  );
  assert.equal(validateNewSession(values({ model: ' ' }), options).model, 'Выберите модель');
  assert.match(
    validateNewSession(values({ model: 'ghost' }), options).model,
    /Модель недоступна/
  );
  assert.match(
    validateNewSession(values({ sandbox: 'read-only', approval: 'ask', title: 'x'.repeat(MAX_TITLE_LENGTH + 1) }), options).title,
    /длиннее/
  );
});

test('danger-full-access требует явного подтверждения', () => {
  const options = { presets: PRESETS, models: ['deepseek-chat'] };
  const denied = validateNewSession(values({ sandbox: 'danger-full-access' }), options);
  assert.match(denied.sandbox, /подтверждения/);

  const confirmed = validateNewSession(
    values({ sandbox: 'danger-full-access', confirmDanger: true }),
    options
  );
  assert.equal(hasErrors(confirmed), false);
});

test('заголовок: пользовательский или из пресета и времени', () => {
  assert.equal(defaultSessionTitle(values({ title: '  Мой чат ' }), NOW), 'Мой чат');
  assert.equal(defaultSessionTitle(values({ preset: 'worker' }), NOW), 'worker · 13.11 22:30');
});

test('buildCreateOptions и запоминание значений', () => {
  const options = buildCreateOptions(values({ preset: 'worker', model: ' m ', title: '' }), NOW);
  assert.deepEqual(options, {
    preset: 'worker',
    model: 'm',
    sandbox: 'workspace-write',
    approval: 'ask',
    title: 'worker · 13.11 22:30'
  });
  assert.deepEqual(rememberedFromValues(values({ preset: 'worker' })), {
    preset: 'worker',
    model: 'deepseek-chat',
    sandbox: 'workspace-write',
    approval: 'ask'
  });
  assert.equal(REMEMBERED_KEY, 'dsh.newSession.last');
});

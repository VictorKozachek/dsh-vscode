import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DANGER_WARNING,
  filterModels,
  handleFormKey,
  initialValues,
  nextFocusIndex,
  presetDescription,
  validateForm
} from '../webview/src/newSession/newSessionModel.ts';

const FORM = {
  presets: [
    { id: 'standard', title: 'standard', description: 'Базовый' },
    { id: 'worker', title: 'worker' }
  ],
  models: ['deepseek-chat', 'deepseek-v4'],
  values: {
    preset: 'standard',
    model: 'deepseek-chat',
    sandbox: 'workspace-write',
    approval: 'ask',
    title: '',
    confirmDanger: false
  },
  errors: {}
};

test('initialValues и валидация формы', () => {
  assert.deepEqual(initialValues(FORM), FORM.values);
  assert.deepEqual(validateForm(FORM.values, FORM), {});
  assert.equal(validateForm({ ...FORM.values, model: '' }, FORM).model, 'Выберите модель');
  assert.equal(validateForm({ ...FORM.values, preset: 'nope' }, FORM).preset, 'Пресет недоступен');
  assert.match(
    validateForm({ ...FORM.values, sandbox: 'danger-full-access' }, FORM).sandbox,
    /подтверждения/
  );
  assert.equal(
    validateForm({ ...FORM.values, sandbox: 'danger-full-access', confirmDanger: true }, FORM).sandbox,
    undefined
  );
});

test('поиск моделей и описание пресета', () => {
  assert.deepEqual(filterModels(FORM.models, 'V4'), ['deepseek-v4']);
  assert.deepEqual(filterModels(FORM.models, '  '), FORM.models);
  assert.equal(presetDescription(FORM, 'standard'), 'Базовый');
  assert.match(presetDescription(FORM, 'unknown'), /Пресет рантайма/);
  assert.match(DANGER_WARNING, /danger-full-access/);
});

test('клавиатура: Esc — отмена, Ctrl/Cmd+Enter — создание', () => {
  assert.equal(handleFormKey('Escape'), 'cancel');
  assert.equal(handleFormKey('Enter', { ctrlKey: true }), 'submit');
  assert.equal(handleFormKey('Enter', { metaKey: true }), 'submit');
  assert.equal(handleFormKey('Enter'), null);
  assert.equal(handleFormKey('Tab'), null);
});

test('фокус-ловушка ходит по кругу', () => {
  assert.equal(nextFocusIndex(0, 3, 1), 1);
  assert.equal(nextFocusIndex(2, 3, 1), 0);
  assert.equal(nextFocusIndex(0, 3, -1), 2);
});

import assert from 'node:assert/strict';
import test from 'node:test';

import { createTranslator } from '../webview/src/i18n/index.ts';
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
  assert.equal(validateForm({ ...FORM.values, model: '' }, FORM).model, 'newSession.error.modelRequired');
  assert.equal(validateForm({ ...FORM.values, preset: 'nope' }, FORM).preset, 'newSession.error.presetUnknown');
  assert.match(
    validateForm({ ...FORM.values, sandbox: 'danger-full-access' }, FORM).sandbox,
    /dangerConfirm/
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
  assert.equal(presetDescription(FORM, 'unknown'), 'newSession.presetFallback');
  assert.equal(DANGER_WARNING, 'newSession.dangerWarning');
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

test('поиск моделей сохраняет выбранную модель', () => {
  assert.deepEqual(filterModels(FORM.models, 'v4', 'deepseek-chat'), ['deepseek-chat', 'deepseek-v4']);
  assert.deepEqual(filterModels(FORM.models, 'v4', 'deepseek-v4'), ['deepseek-v4']);
  assert.deepEqual(filterModels(FORM.models, '', undefined), FORM.models);
});

test('i18n: ключи формы есть в ru и en', () => {
  const ru = createTranslator('ru');
  const en = createTranslator('en');
  for (const key of [
    'newSession.error.presetRequired',
    'newSession.error.dangerConfirm',
    'newSession.dangerWarning',
    'newSession.presetFallback'
  ]) {
    assert.notEqual(ru(key), key, `ru: ${key}`);
    assert.notEqual(en(key), key, `en: ${key}`);
  }
  assert.notEqual(ru('newSession.error.dangerConfirm'), en('newSession.error.dangerConfirm'));
});

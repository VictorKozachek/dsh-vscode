import assert from 'node:assert/strict';
import test from 'node:test';

import { validateSettings } from '../webview/src/context/settingsModel.ts';

test('validateSettings: значения по умолчанию и валидные поля', () => {
  const result = validateSettings({ sandboxMode: 'read-only', 'workspace.graceMinutes': '5' });
  assert.equal(result.valid, true);
  assert.equal(result.values.sandboxMode, 'read-only');
  assert.equal(result.values['workspace.graceMinutes'], 5);
  assert.equal(result.values.executablePath, 'dsh');
});

test('validateSettings: ошибки для enum/числа/списка', () => {
  const result = validateSettings({
    sandboxMode: 'bogus',
    approvalPolicy: 'sometimes',
    'workspace.graceMinutes': '-1',
    models: 42
  });
  assert.equal(result.valid, false);
  assert.match(result.errors.sandboxMode, /допустимо/);
  assert.match(result.errors.approvalPolicy, /допустимо/);
  assert.match(result.errors['workspace.graceMinutes'], /неотрицательное/);
  assert.match(result.errors.models, /список строк/);
});

test('validateSettings: models из строки через запятую', () => {
  const result = validateSettings({ models: 'a, b ,c' });
  assert.deepEqual(result.values.models, ['a', 'b', 'c']);
});

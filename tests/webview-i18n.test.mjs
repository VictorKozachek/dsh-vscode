import assert from 'node:assert/strict';
import test from 'node:test';

import { DICTIONARIES, createTranslator, resolveLocale } from '../webview/src/i18n/index.ts';

test('i18n: у ru и en одинаковый набор ключей и нет пустых строк', () => {
  const ruKeys = Object.keys(DICTIONARIES.ru).sort();
  const enKeys = Object.keys(DICTIONARIES.en).sort();

  assert.deepEqual(enKeys, ruKeys, 'словари должны совпадать по ключам');
  for (const locale of ['ru', 'en']) {
    for (const [key, value] of Object.entries(DICTIONARIES[locale])) {
      assert.equal(typeof value, 'string', `${locale}.${key}`);
      assert.notEqual(value.trim(), '', `${locale}.${key} не должен быть пустым`);
    }
  }
});

test('i18n: переводы подставляются по локали и различаются', () => {
  const ru = createTranslator('ru');
  const en = createTranslator('en');

  assert.equal(ru('composer.send'), 'Отправить');
  assert.equal(en('composer.send'), 'Send');
  assert.notEqual(ru('empty.hint'), en('empty.hint'));
});

test('i18n: локаль определяется по языку VS Code', () => {
  assert.equal(resolveLocale('ru'), 'ru');
  assert.equal(resolveLocale('ru-RU'), 'ru');
  assert.equal(resolveLocale('en-US'), 'en');
  assert.equal(resolveLocale('de-DE'), 'en');
  assert.equal(resolveLocale(undefined), 'ru');
});

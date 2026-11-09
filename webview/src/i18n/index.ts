/**
 * i18n-каркас панели: строки вынесены в словари ru/en.
 *
 * Модуль без импортов — его можно тестировать в Node (`tests/webview-i18n.test.mjs`).
 */

/** Поддерживаемые локали. */
export type Locale = 'ru' | 'en';

const ru = {
  'panel.title': 'DSH',
  'header.workspace': 'Воркспейс',
  'header.model': 'Модель',
  'header.sandbox': 'Песочница',
  'header.stop': 'Стоп',
  'empty.title': 'Пока пусто',
  'empty.hint': 'Напишите запрос — ответ появится здесь.',
  'composer.label': 'Сообщение для DSH',
  'composer.placeholder': 'Спросите DSH…',
  'composer.hint': 'Enter — отправить, Shift+Enter — новая строка',
  'composer.send': 'Отправить',
  'log.label': 'Лента сообщений',
  'message.you': 'Вы',
  'message.assistant': 'DSH',
  'message.system': 'Система',
  'status.idle': 'Готов',
  'status.thinking': 'Думает…',
  'status.stopped': 'Остановлено',
  'status.tokens': 'Токены',
  'state.noWorkspace': 'нет папки'
} as const;

const en: Readonly<Record<keyof typeof ru, string>> = {
  'panel.title': 'DSH',
  'header.workspace': 'Workspace',
  'header.model': 'Model',
  'header.sandbox': 'Sandbox',
  'header.stop': 'Stop',
  'empty.title': 'Nothing here yet',
  'empty.hint': 'Ask a question — the answer will appear here.',
  'composer.label': 'Message to DSH',
  'composer.placeholder': 'Ask DSH…',
  'composer.hint': 'Enter — send, Shift+Enter — new line',
  'composer.send': 'Send',
  'log.label': 'Message log',
  'message.you': 'You',
  'message.assistant': 'DSH',
  'message.system': 'System',
  'status.idle': 'Ready',
  'status.thinking': 'Thinking…',
  'status.stopped': 'Stopped',
  'status.tokens': 'Tokens',
  'state.noWorkspace': 'no folder'
};

/** Ключ строки перевода. */
export type TranslationKey = keyof typeof ru;

/** Словари по локалям (для тестов паритета ключей). */
export const DICTIONARIES: Readonly<Record<Locale, Readonly<Record<TranslationKey, string>>>> = {
  ru,
  en
};

/** Функция перевода. */
export type Translator = (key: TranslationKey) => string;

/** Перевод для локали (с фолбэком на ru). */
export function createTranslator(locale: Locale): Translator {
  return (key) => DICTIONARIES[locale]?.[key] ?? ru[key];
}

/** Локаль по языку VS Code / браузера: `ru`, иначе `en`. */
export function resolveLocale(language?: string): Locale {
  const value = language ?? 'ru';
  return value.toLowerCase().startsWith('ru') ? 'ru' : 'en';
}

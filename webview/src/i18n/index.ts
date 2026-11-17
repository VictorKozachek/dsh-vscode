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
  'composer.createSession': 'Создать сессию',
  'header.session': 'Сессия',
  'header.noSession': 'нет активной сессии',
  'chat.historyUnavailable': 'История недоступна — начинаем с чистого листа',
  'chat.retry': 'Повторить',
  'log.label': 'Лента сообщений',
  'message.you': 'Вы',
  'message.assistant': 'DSH',
  'message.system': 'Система',
  'status.idle': 'Готов',
  'status.thinking': 'Думает…',
  'status.stopped': 'Остановлено',
  'status.tokens': 'Токены',
  'state.noWorkspace': 'нет папки',
  'status.streaming': 'Стриминг ответа…',
  'status.cancelled': 'Остановлено',
  'status.error': 'Ошибка',
  'tool.call': 'Инструмент',
  'tool.arguments': 'Аргументы',
  'tool.result': 'Результат',
  'tool.status.running': 'выполняется',
  'tool.status.done': 'готово',
  'tool.status.error': 'ошибка',
  'tool.duration': 'Длительность',
  'markdown.copy': 'Копировать',
  'markdown.copied': 'Скопировано',
  'message.cancelled': 'остановлено',
  'message.error': 'ошибка',
  'newSession.title': 'Новая сессия',
  'newSession.preset': 'Пресет',
  'newSession.model': 'Модель',
  'newSession.modelSearch': 'Поиск модели',
  'newSession.sandbox': 'Sandbox',
  'newSession.approval': 'Подтверждения',
  'newSession.titleField': 'Заголовок',
  'newSession.titlePlaceholder': 'Сгенерируется из пресета и времени',
  'newSession.dangerConfirm': 'Понимаю риски danger-full-access',
  'newSession.cancel': 'Отмена',
  'newSession.create': 'Создать',
  'newSession.presetFallback': 'Пресет рантайма DSH',
  'newSession.dangerWarning':
    'danger-full-access снимает ограничения sandbox: агент сможет писать в любые файлы и запускать команды без ограничений воркспейса.',
  'newSession.error.presetRequired': 'Выберите пресет',
  'newSession.error.presetUnknown': 'Пресет недоступен',
  'newSession.error.modelRequired': 'Выберите модель',
  'newSession.error.modelUnknown': 'Модель недоступна',
  'newSession.error.sandboxUnknown': 'Неизвестный sandbox-режим',
  'newSession.error.dangerConfirm': 'danger-full-access требует явного подтверждения',
  'newSession.error.approvalUnknown': 'Неизвестная политика подтверждений',
  'newSession.error.titleTooLong': 'Слишком длинный заголовок',
  'approval.title': 'Требуется подтверждение',
  'approval.kind': 'Операция',
  'approval.allow': 'Разрешить',
  'approval.allowSession': 'Разрешить для этой сессии',
  'approval.deny': 'Отклонить',
  'approval.showDiff': 'Показать diff'
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
  'composer.createSession': 'Create session',
  'header.session': 'Session',
  'header.noSession': 'no active session',
  'chat.historyUnavailable': 'History unavailable — starting from a clean slate',
  'chat.retry': 'Retry',
  'log.label': 'Message log',
  'message.you': 'You',
  'message.assistant': 'DSH',
  'message.system': 'System',
  'status.idle': 'Ready',
  'status.thinking': 'Thinking…',
  'status.stopped': 'Stopped',
  'status.tokens': 'Tokens',
  'state.noWorkspace': 'no folder',
  'status.streaming': 'Streaming…',
  'status.cancelled': 'Stopped',
  'status.error': 'Error',
  'tool.call': 'Tool',
  'tool.arguments': 'Arguments',
  'tool.result': 'Result',
  'tool.status.running': 'running',
  'tool.status.done': 'done',
  'tool.status.error': 'error',
  'tool.duration': 'Duration',
  'markdown.copy': 'Copy',
  'markdown.copied': 'Copied',
  'message.cancelled': 'stopped',
  'message.error': 'error',
  'newSession.title': 'New session',
  'newSession.preset': 'Preset',
  'newSession.model': 'Model',
  'newSession.modelSearch': 'Search model',
  'newSession.sandbox': 'Sandbox',
  'newSession.approval': 'Approvals',
  'newSession.titleField': 'Title',
  'newSession.titlePlaceholder': 'Generated from preset and time',
  'newSession.dangerConfirm': 'I understand danger-full-access risks',
  'newSession.cancel': 'Cancel',
  'newSession.create': 'Create',
  'newSession.presetFallback': 'DSH runtime preset',
  'newSession.dangerWarning':
    'danger-full-access removes sandbox limits: the agent can write any file and run commands outside the workspace.',
  'newSession.error.presetRequired': 'Choose a preset',
  'newSession.error.presetUnknown': 'Preset unavailable',
  'newSession.error.modelRequired': 'Choose a model',
  'newSession.error.modelUnknown': 'Model unavailable',
  'newSession.error.sandboxUnknown': 'Unknown sandbox mode',
  'newSession.error.dangerConfirm': 'danger-full-access requires explicit confirmation',
  'newSession.error.approvalUnknown': 'Unknown approval policy',
  'newSession.error.titleTooLong': 'Title is too long',
  'approval.title': 'Approval required',
  'approval.kind': 'Operation',
  'approval.allow': 'Allow',
  'approval.allowSession': 'Allow for this session',
  'approval.deny': 'Deny',
  'approval.showDiff': 'Show diff'
};

/** Ключ строки перевода. */
export type TranslationKey = keyof typeof ru;

/** Словари по локалям (для тестов паритета ключей). */
export const DICTIONARIES: Readonly<Record<Locale, Readonly<Record<TranslationKey, string>>>> = {
  ru,
  en
};

/** Функция перевода. */
export type Translator = (key: TranslationKey | string) => string;

/**
 * Перевод для локали (с фолбэком на ru).
 *
 * Неизвестная строка возвращается как есть: так в UI попадают тексты ошибок
 * рантайма и описания пресетов, пришедшие из extension host.
 */
export function createTranslator(locale: Locale): Translator {
  return (key) => DICTIONARIES[locale]?.[key as TranslationKey] ?? ru[key as TranslationKey] ?? key;
}

/** Локаль по языку VS Code / браузера: `ru`, иначе `en`. */
export function resolveLocale(language?: string): Locale {
  const value = language ?? 'ru';
  return value.toLowerCase().startsWith('ru') ? 'ru' : 'en';
}

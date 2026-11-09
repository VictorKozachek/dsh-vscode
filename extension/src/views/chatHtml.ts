/**
 * Чистая часть панели чата: разбор сообщений из WebView и сборка HTML с CSP.
 *
 * Здесь нет импорта `vscode`, поэтому модуль тестируется в Node
 * (`tests/chat-view.test.mjs`), а `chatViewProvider.ts` остаётся тонкой
 * обвязкой вокруг `WebviewView`.
 */

/** Роль автора сообщения. */
export type ChatRole = 'user' | 'assistant' | 'system';

/** Сообщение в ленте панели. */
export interface ChatMessageDto {
  readonly id: string;
  readonly role: ChatRole;
  readonly text: string;
}

/** Состояние панели. */
export type ChatPanelStatus = 'idle' | 'thinking' | 'stopped';

/** Что панель знает о воркспейсе и настройках. */
export interface ChatPanelStateDto {
  readonly workspaceName: string;
  readonly model: string;
  readonly sandboxMode: string;
  readonly status: ChatPanelStatus;
  readonly locale: 'ru' | 'en';
}

/** Сообщения WebView → extension. */
export type WebviewMessage =
  | { readonly kind: 'ready' }
  | { readonly kind: 'stop' }
  | { readonly kind: 'sendMessage'; readonly text: string };

/** Типы сообщений WebView → extension (для проверки паритета с webview/). */
export const WEBVIEW_MESSAGE_TYPES = ['ready', 'sendMessage', 'stop'] as const;

/** Типы сообщений extension → WebView (для проверки паритета с webview/). */
export const EXTENSION_MESSAGE_TYPES = ['state', 'message', 'status', 'replaceMessages'] as const;

/** Сообщения extension → WebView. */
export type ExtensionMessage =
  | { readonly type: 'state'; readonly state: ChatPanelStateDto }
  | { readonly type: 'message'; readonly message: ChatMessageDto }
  | { readonly type: 'status'; readonly status: ChatPanelStatus }
  | { readonly type: 'replaceMessages'; readonly messages: readonly ChatMessageDto[] };

/**
 * Разбирает сообщение из WebView. Возвращает `null`, если сообщение не по
 * схеме (текст пустой, неизвестный тип, не объект) — в ленту ничего не уходит.
 */
export function parseWebviewMessage(raw: unknown): WebviewMessage | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return null;
  }
  const record = raw as Record<string, unknown>;
  const type = record['type'];

  if (type === 'ready') {
    return { kind: 'ready' };
  }
  if (type === 'stop') {
    return { kind: 'stop' };
  }
  if (type === 'sendMessage') {
    const text = typeof record['text'] === 'string' ? record['text'].trim() : '';
    return text === '' ? null : { kind: 'sendMessage', text };
  }
  return null;
}

/** Ссылки на ассеты, которые Vite положил в `webview/dist/index.html`. */
export interface ViteAssets {
  readonly script: string | null;
  readonly style: string | null;
}

/** Достаёт из собранного `index.html` относительные пути скрипта и стилей. */
export function extractViteAssets(html: string): ViteAssets {
  const script = /<script[^>]*\bsrc="([^"]+)"/i.exec(html)?.[1] ?? null;
  const style =
    /<link[^>]*\brel="stylesheet"[^>]*\bhref="([^"]+)"/i.exec(html)?.[1] ??
    /<link[^>]*\bhref="([^"]+)"[^>]*\brel="stylesheet"/i.exec(html)?.[1] ??
    null;
  return { script, style };
}

/** Настройки HTML-оболочки WebView. */
export interface ChatViewHtmlOptions {
  readonly cspSource: string;
  readonly nonce: string;
  readonly scriptUri: string;
  readonly styleUri: string | null;
  readonly title: string;
  readonly lang?: string;
}

/**
 * Собирает HTML панели: CSP с nonce, внешние скрипты/стили из `webview/dist`.
 * Инлайновых скриптов нет — только `script` с nonce.
 */
export function renderChatViewHtml(options: ChatViewHtmlOptions): string {
  const lang = options.lang ?? 'ru';
  const styleTag =
    options.styleUri === null
      ? ''
      : `\n  <link rel="stylesheet" nonce="${escapeHtml(options.nonce)}" href="${escapeHtml(options.styleUri)}" />`;

  return `<!doctype html>
<html lang="${escapeHtml(lang)}">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${escapeHtml(options.cspSource)} data:; style-src ${escapeHtml(options.cspSource)} 'unsafe-inline'; script-src 'nonce-${escapeHtml(options.nonce)}'; font-src ${escapeHtml(options.cspSource)}; base-uri 'none'; form-action 'none';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(options.title)}</title>${styleTag}
</head>
<body>
  <div id="root"></div>
  <script type="module" nonce="${escapeHtml(options.nonce)}" src="${escapeHtml(options.scriptUri)}"></script>
</body>
</html>
`;
}

/** HTML-заглушка, если `webview/dist` ещё не собран. */
export function renderChatViewNoticeHtml(options: {
  readonly cspSource: string;
  readonly title: string;
  readonly message: string;
  readonly hint: string;
}): string {
  return `<!doctype html>
<html lang="ru">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${escapeHtml(options.cspSource)} 'unsafe-inline';" />
  <title>${escapeHtml(options.title)}</title>
</head>
<body>
  <h1>${escapeHtml(options.title)}</h1>
  <p>${escapeHtml(options.message)}</p>
  <p><code>${escapeHtml(options.hint)}</code></p>
</body>
</html>
`;
}

/** Экранирует HTML-спецсимволы (заголовок, URI, nonce). */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

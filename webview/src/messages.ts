/**
 * Контракт сообщений WebView панели DSH ↔ extension host.
 *
 * Копия типов живёт в `extension/src/views/chatHtml.ts` (обратная зависимость
 * extension → webview запрещена); совпадение списков типов проверяется тестом
 * `tests/chat-view.test.mjs`.
 */

/** Пресет рантайма для формы New Session. */
export interface NewSessionPresetDto {
  readonly id: string;
  readonly title: string;
  readonly description?: string | undefined;
}

/** Значения формы New Session (wire). */
export interface NewSessionValuesDto {
  readonly preset: string;
  readonly model: string;
  readonly sandbox: 'read-only' | 'workspace-write' | 'danger-full-access';
  readonly approval: 'ask' | 'auto' | 'never';
  readonly title: string;
  readonly confirmDanger: boolean;
}

/** Форма New Session. */
export interface NewSessionFormDto {
  readonly presets: readonly NewSessionPresetDto[];
  readonly models: readonly string[];
  readonly values: NewSessionValuesDto;
  readonly errors: Readonly<Record<string, string>>;
}

/** Сообщения WebView → extension host. */
export const WEBVIEW_MESSAGE_TYPES = [
  'ready',
  'sendMessage',
  'stop',
  'newSessionSubmit',
  'newSessionCancel'
] as const;

/** Сообщения extension host → WebView. */
export const EXTENSION_MESSAGE_TYPES = [
  'state',
  'message',
  'status',
  'replaceMessages',
  'chatStatus',
  'chatToken',
  'chatToolCall',
  'chatToolResult',
  'chatDone',
  'chatCancelled',
  'newSessionOpen',
  'newSessionUpdate',
  'newSessionClose'
] as const;

/** Статус потока ответа. */
export type ChatStreamStatus = 'idle' | 'streaming' | 'cancelled' | 'error';

/** Вызов инструмента агента. */
export interface ChatToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: Record<string, unknown>;
}

/** Результат инструмента. */
export interface ChatToolResult {
  readonly callId: string;
  readonly ok: boolean;
  readonly result?: unknown;
  readonly error?: string;
}

/** Роль автора сообщения. */
export type ChatRole = 'user' | 'assistant' | 'system';

/** Сообщение в ленте. */
export interface ChatMessage {
  readonly id: string;
  readonly role: ChatRole;
  readonly text: string;
}

/** Состояние панели. */
export type ChatPanelStatus = 'idle' | 'thinking' | 'stopped';

/** Что панель знает о воркспейсе и настройках. */
export interface ChatPanelState {
  readonly workspaceName: string;
  readonly model: string;
  readonly sandboxMode: string;
  readonly status: ChatPanelStatus;
  readonly locale: 'ru' | 'en';
}

/** Сообщение из WebView в extension host. */
export type WebviewToExtension =
  | { readonly type: 'ready' }
  | { readonly type: 'sendMessage'; readonly text: string }
  | { readonly type: 'stop' }
  | { readonly type: 'newSessionSubmit'; readonly values: NewSessionValuesDto }
  | { readonly type: 'newSessionCancel' };

/** Сообщение из extension host в WebView. */
export type ExtensionToWebview =
  | { readonly type: 'state'; readonly state: ChatPanelState }
  | { readonly type: 'message'; readonly message: ChatMessage }
  | { readonly type: 'status'; readonly status: ChatPanelStatus }
  | { readonly type: 'replaceMessages'; readonly messages: readonly ChatMessage[] }
  | { readonly type: 'chatStatus'; readonly status: ChatStreamStatus; readonly detail?: string }
  | { readonly type: 'chatToken'; readonly turnId: string; readonly text: string }
  | { readonly type: 'chatToolCall'; readonly call: ChatToolCall }
  | { readonly type: 'chatToolResult'; readonly result: ChatToolResult }
  | { readonly type: 'chatDone'; readonly turnId: string; readonly finishReason: 'stop' | 'cancelled' | 'error' }
  | { readonly type: 'chatCancelled' }
  | { readonly type: 'newSessionOpen'; readonly form: NewSessionFormDto }
  | { readonly type: 'newSessionUpdate'; readonly form: NewSessionFormDto }
  | { readonly type: 'newSessionClose' };

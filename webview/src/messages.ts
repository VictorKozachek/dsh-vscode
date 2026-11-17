/**
 * Контракт сообщений WebView панели DSH ↔ extension host.
 *
 * Копия типов живёт в `extension/src/views/chatHtml.ts` (обратная зависимость
 * extension → webview запрещена); совпадение списков типов проверяется тестом
 * `tests/chat-view.test.mjs`.
 */

/** Решение по approval-запросу. */
export type ApprovalDecisionKind = 'allow' | 'allow-session' | 'deny';

/** Запрос подтверждения инструмента. */
export interface ApprovalRequestMessage {
  readonly id: string;
  readonly tool: string;
  readonly kind: 'read' | 'write' | 'execute' | 'network';
  readonly targetPath?: string | undefined;
  readonly arguments?: Record<string, unknown> | undefined;
  readonly sessionId: string;
  readonly createdAt: string;
}

/** Запись ленты в порядке поступления (#024). */
export type FeedRecordDto =
  | { readonly kind: 'message'; readonly message: ChatMessage }
  | { readonly kind: 'toolCall'; readonly call: ChatToolCall }
  | { readonly kind: 'toolResult'; readonly result: ChatToolResult };

/** Состояние привязки чата к сессии (#024). */
export interface ChatSessionDto {
  readonly sessionId: string | null;
  readonly title: string | null;
  readonly model: string;
  readonly preset: string;
  readonly status: string;
  readonly historyState: 'replayed' | 'empty' | 'unavailable';
}

/** Сообщения WebView → extension host. */
export const WEBVIEW_MESSAGE_TYPES = [
  'ready',
  'sendMessage',
  'stop',
  'approvalResolve',
  'approvalShowDiff',
  'draftChanged',
  'openNewSession',
  'retryChat'
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
  'approvalRequest',
  'approvalResolved',
  'chatSession',
  'composerDraft',
  'replaceFeed'
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
  | { readonly type: 'approvalResolve'; readonly id: string; readonly decision: ApprovalDecisionKind }
  | { readonly type: 'approvalShowDiff'; readonly id: string }
  | { readonly type: 'draftChanged'; readonly text: string }
  | { readonly type: 'openNewSession' }
  | { readonly type: 'retryChat' };

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
  | { readonly type: 'approvalRequest'; readonly request: ApprovalRequestMessage }
  | { readonly type: 'approvalResolved'; readonly id: string; readonly decision: ApprovalDecisionKind }
  | { readonly type: 'chatSession'; readonly session: ChatSessionDto }
  | { readonly type: 'composerDraft'; readonly text: string }
  | { readonly type: 'replaceFeed'; readonly records: readonly FeedRecordDto[] };

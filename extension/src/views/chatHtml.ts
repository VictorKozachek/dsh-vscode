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

/** Sandbox-режим в форме New Session. */
export type NewSessionSandboxDto = 'read-only' | 'workspace-write' | 'danger-full-access';

/** Политика подтверждений в форме New Session. */
export type NewSessionApprovalDto = 'ask' | 'auto' | 'never';

/** Пресет рантайма для формы. */
export interface NewSessionPresetDto {
  readonly id: string;
  readonly title: string;
  readonly description?: string | undefined;
}

/** Значения формы New Session (wire). */
export interface NewSessionValuesDto {
  readonly preset: string;
  readonly model: string;
  readonly sandbox: NewSessionSandboxDto;
  readonly approval: NewSessionApprovalDto;
  readonly title: string;
  readonly confirmDanger: boolean;
}

/** Форма New Session для WebView. */
export interface NewSessionFormDto {
  readonly presets: readonly NewSessionPresetDto[];
  readonly models: readonly string[];
  readonly values: NewSessionValuesDto;
  readonly errors: Readonly<Record<string, string>>;
}

/** Решение пользователя по approval-запросу. */
export type ApprovalDecisionDto = 'allow' | 'allow-session' | 'deny';

/** Запрос подтверждения инструмента для инлайн-карточки. */
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
  | { readonly kind: 'message'; readonly message: ChatMessageDto }
  | { readonly kind: 'toolCall'; readonly call: ChatToolCallDto }
  | { readonly kind: 'toolResult'; readonly result: ChatToolResultDto };

/** Состояние привязки чата к сессии (#024). */
export interface ChatSessionDto {
  readonly sessionId: string | null;
  readonly title: string | null;
  readonly model: string;
  readonly preset: string;
  readonly status: string;
  /**
   * Состояние истории: `replayed` — восстановлена из транскрипта,
   * `empty` — сессия новая/пустая, `unavailable` — транскрипт недоступен.
   */
  readonly historyState: 'replayed' | 'empty' | 'unavailable';
}

/** Сообщения WebView → extension. */
export type WebviewMessage =
  | { readonly kind: 'ready' }
  | { readonly kind: 'stop' }
  | { readonly kind: 'sendMessage'; readonly text: string }
  | { readonly kind: 'newSessionSubmit'; readonly values: NewSessionValuesDto }
  | { readonly kind: 'newSessionCancel' }
  | { readonly kind: 'approvalResolve'; readonly id: string; readonly decision: ApprovalDecisionDto }
  | { readonly kind: 'approvalShowDiff'; readonly id: string }
  | { readonly kind: 'draftChanged'; readonly text: string }
  | { readonly kind: 'openNewSession' }
  | { readonly kind: 'retryChat' };

/** Типы сообщений WebView → extension (для проверки паритета с webview/). */
export const WEBVIEW_MESSAGE_TYPES = [
  'ready',
  'sendMessage',
  'stop',
  'newSessionSubmit',
  'newSessionCancel',
  'approvalResolve',
  'approvalShowDiff',
  'draftChanged',
  'openNewSession',
  'retryChat'
] as const;

/** Статус потока ответа в панели. */
export type ChatStreamStatus = 'idle' | 'streaming' | 'cancelled' | 'error';

/** Вызов инструмента агента (`tool.call`). */
export interface ChatToolCallDto {
  readonly id: string;
  readonly name: string;
  readonly arguments: Record<string, unknown>;
}

/** Результат инструмента (`tool.result`). */
export interface ChatToolResultDto {
  readonly callId: string;
  readonly ok: boolean;
  readonly result?: unknown;
  readonly error?: string;
}

/** Типы сообщений extension → WebView (для проверки паритета с webview/). */
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
  'newSessionClose',
  'approvalRequest',
  'approvalResolved',
  'chatSession',
  'composerDraft',
  'replaceFeed'
] as const;

/** Сообщения extension → WebView. */
export type ExtensionMessage =
  | { readonly type: 'state'; readonly state: ChatPanelStateDto }
  | { readonly type: 'message'; readonly message: ChatMessageDto }
  | { readonly type: 'status'; readonly status: ChatPanelStatus }
  | { readonly type: 'replaceMessages'; readonly messages: readonly ChatMessageDto[] }
  | { readonly type: 'chatStatus'; readonly status: ChatStreamStatus; readonly detail?: string }
  | { readonly type: 'chatToken'; readonly turnId: string; readonly text: string }
  | { readonly type: 'chatToolCall'; readonly call: ChatToolCallDto }
  | { readonly type: 'chatToolResult'; readonly result: ChatToolResultDto }
  | { readonly type: 'chatDone'; readonly turnId: string; readonly finishReason: 'stop' | 'cancelled' | 'error' }
  | { readonly type: 'chatCancelled' }
  | { readonly type: 'newSessionOpen'; readonly form: NewSessionFormDto }
  | { readonly type: 'newSessionUpdate'; readonly form: NewSessionFormDto }
  | { readonly type: 'newSessionClose' }
  | { readonly type: 'approvalRequest'; readonly request: ApprovalRequestMessage }
  | { readonly type: 'approvalResolved'; readonly id: string; readonly decision: ApprovalDecisionDto }
  | { readonly type: 'chatSession'; readonly session: ChatSessionDto }
  | { readonly type: 'composerDraft'; readonly text: string }
  | { readonly type: 'replaceFeed'; readonly records: readonly FeedRecordDto[] };

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
  if (type === 'newSessionCancel') {
    return { kind: 'newSessionCancel' };
  }
  if (type === 'newSessionSubmit') {
    const values = parseNewSessionValues(record['values']);
    return values === null ? null : { kind: 'newSessionSubmit', values };
  }
  if (type === 'approvalResolve') {
    const id = typeof record['id'] === 'string' ? record['id'] : '';
    const decision = record['decision'];
    if (id === '' || (decision !== 'allow' && decision !== 'allow-session' && decision !== 'deny')) {
      return null;
    }
    return { kind: 'approvalResolve', id, decision };
  }
  if (type === 'approvalShowDiff') {
    const id = typeof record['id'] === 'string' ? record['id'] : '';
    return id === '' ? null : { kind: 'approvalShowDiff', id };
  }
  if (type === 'draftChanged') {
    const text = typeof record['text'] === 'string' ? record['text'] : '';
    return { kind: 'draftChanged', text };
  }
  if (type === 'openNewSession') {
    return { kind: 'openNewSession' };
  }
  if (type === 'retryChat') {
    return { kind: 'retryChat' };
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseNewSessionValues(raw: unknown): NewSessionValuesDto | null {
  if (!isRecord(raw)) {
    return null;
  }
  const preset = typeof raw['preset'] === 'string' ? raw['preset'].trim() : '';
  const model = typeof raw['model'] === 'string' ? raw['model'].trim() : '';
  const title = typeof raw['title'] === 'string' ? raw['title'] : '';
  const sandbox = raw['sandbox'];
  const approval = raw['approval'];
  const confirmDanger = raw['confirmDanger'];
  if (
    preset === '' ||
    model === '' ||
    (sandbox !== 'read-only' && sandbox !== 'workspace-write' && sandbox !== 'danger-full-access') ||
    (approval !== 'ask' && approval !== 'auto' && approval !== 'never')
  ) {
    return null;
  }
  return { preset, model, sandbox, approval, title, confirmDanger: confirmDanger === true };
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
  readonly lang?: string;
}): string {
  return `<!doctype html>
<html lang="${escapeHtml(options.lang ?? 'ru')}">
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

// --- сборка HTML панели -----------------------------------------------------

/** Источники для сборки HTML панели (без `vscode` — тестируется в Node). */
export interface ChatViewHtmlInputs {
  readonly cspSource: string;
  readonly nonce: string;
  readonly locale: 'ru' | 'en';
  /** Читает `webview/dist/index.html`; `null` — WebView ещё не собран. */
  readonly readIndexHtml: () => Promise<string | null>;
  /** Переводит относительный путь ассета в webview-URI. */
  readonly toWebviewUri: (relativePath: string) => string;
}

/**
 * Собирает HTML панели: либо приложение из `webview/dist` с CSP и nonce, либо
 * заглушку «соберите WebView». Ошибки чтения/разбора не пробрасываются наружу.
 */
export async function buildChatViewHtml(inputs: ChatViewHtmlInputs): Promise<string> {
  let indexHtml: string | null = null;
  try {
    indexHtml = await inputs.readIndexHtml();
  } catch {
    indexHtml = null;
  }

  const assets = indexHtml === null ? null : extractViteAssets(indexHtml);
  if (assets === null || assets.script === null) {
    return renderChatViewNoticeHtml({
      cspSource: inputs.cspSource,
      title: 'DSH',
      message: 'WebView ещё не собран — панель откроется после сборки.',
      hint: 'pnpm build',
      lang: inputs.locale
    });
  }

  return renderChatViewHtml({
    cspSource: inputs.cspSource,
    nonce: inputs.nonce,
    scriptUri: inputs.toWebviewUri(assets.script),
    styleUri: assets.style === null ? null : inputs.toWebviewUri(assets.style),
    title: 'DSH',
    lang: inputs.locale
  });
}

// --- сессия панели ----------------------------------------------------------

/** Настройки `ChatSession`. */
export interface ChatSessionOptions {
  /** Текст ответа-эха (подменяется в тестах); локаль нужна для i18n. */
  readonly echo?: ((text: string, locale: 'ru' | 'en') => string) | undefined;
  /** Сколько сообщений держать в ленте. */
  readonly maxMessages?: number | undefined;
  /** Пауза перед ответом-эхом: статус `thinking` должен быть виден в UI. */
  readonly replyDelayMs?: number | undefined;
}

const DEFAULT_MAX_MESSAGES = 200;
const DEFAULT_REPLY_DELAY_MS = 150;

/**
 * Состояние панели без привязки к `vscode`: лента, статус и превращение
 * сообщений WebView в исходящие сообщения extension host.
 *
 * `handle()` сразу отдаёт `thinking` и сообщение пользователя, а ответ-эхо и
 * `idle` приходят через `emit` после `replyDelayMs` — так кнопка «Стоп»
 * успевает стать активной, а её нажатие отменяет неотправленный ответ.
 * Чистая логика — покрыта `tests/chat-session.test.mjs`; `ChatViewProvider`
 * остаётся тонкой обвязкой (WebviewView + CSP + postMessage).
 */
export class ChatSession {
  readonly #options: ChatSessionOptions;
  readonly #messages: ChatMessageDto[] = [];
  #status: ChatPanelStatus = 'idle';
  #counter = 0;
  #pendingReply: NodeJS.Timeout | undefined;

  constructor(options: ChatSessionOptions = {}) {
    this.#options = options;
  }

  get status(): ChatPanelStatus {
    return this.#status;
  }

  get messages(): readonly ChatMessageDto[] {
    return this.#messages;
  }

  /**
   * Обрабатывает сообщение WebView. Возвращает сообщения на отправку сразу;
   * ответ-эхо приходит в `emit` (если это `sendMessage`).
   */
  handle(
    message: WebviewMessage,
    state: () => Omit<ChatPanelStateDto, 'status'>,
    emit: (message: ExtensionMessage) => void = () => undefined
  ): ExtensionMessage[] {
    // New Session (#023) обслуживает NewSessionController, подтверждения —
    // ApprovalBroker (#009), привязку к сессии — ChatController (#024).
    if (
      message.kind === 'newSessionSubmit' ||
      message.kind === 'newSessionCancel' ||
      message.kind === 'approvalResolve' ||
      message.kind === 'approvalShowDiff' ||
      message.kind === 'draftChanged' ||
      message.kind === 'openNewSession' ||
      message.kind === 'retryChat'
    ) {
      return [];
    }

    if (message.kind === 'ready') {
      const outgoing: ExtensionMessage[] = [
        { type: 'state', state: { ...state(), status: this.#status } }
      ];
      if (this.#messages.length > 0) {
        outgoing.push({ type: 'replaceMessages', messages: [...this.#messages] });
      }
      return outgoing;
    }

    if (message.kind === 'stop') {
      this.#cancelPendingReply();
      this.#status = 'stopped';
      return [{ type: 'status', status: 'stopped' }];
    }

    const locale = state().locale;
    this.#status = 'thinking';

    const user = this.#make('user', message.text);
    this.#push(user);

    const delay = this.#options.replyDelayMs ?? DEFAULT_REPLY_DELAY_MS;
    this.#cancelPendingReply();
    this.#pendingReply = setTimeout(() => {
      this.#pendingReply = undefined;
      const fallback = locale === 'en' ? `Echo: ${message.text}` : `Эхо: ${message.text}`;
      const reply = this.#options.echo?.(message.text, locale) ?? fallback;
      const assistant = this.#make('assistant', reply);
      this.#push(assistant);
      this.#status = 'idle';
      emit({ type: 'message', message: assistant });
      emit({ type: 'status', status: 'idle' });
    }, delay);
    this.#pendingReply.unref?.();

    return [
      { type: 'status', status: 'thinking' },
      { type: 'message', message: user }
    ];
  }

  /** Сообщение из extension host: попадает в ленту и уходит в WebView. */
  append(message: ChatMessageDto): ExtensionMessage[] {
    this.#push(message);
    return [{ type: 'message', message }];
  }

  /** Снимает неотправленный ответ (при закрытии панели). */
  dispose(): void {
    this.#cancelPendingReply();
  }

  #cancelPendingReply(): void {
    if (this.#pendingReply !== undefined) {
      clearTimeout(this.#pendingReply);
      this.#pendingReply = undefined;
    }
  }

  #make(role: ChatRole, text: string): ChatMessageDto {
    this.#counter += 1;
    return { id: `${role}-${String(this.#counter)}`, role, text };
  }

  #push(message: ChatMessageDto): void {
    this.#messages.push(message);
    const max = this.#options.maxMessages ?? DEFAULT_MAX_MESSAGES;
    if (this.#messages.length > max) {
      this.#messages.splice(0, this.#messages.length - max);
    }
  }
}

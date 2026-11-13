/**
 * Потоковый чат на стороне extension host: подписка на события `DshBridge` →
 * сообщения WebView, батчинг токенов (не чаще ~30 fps) и отмена через
 * `turn.cancel`.
 *
 * Модуль без `vscode`: мост подключается портом `ChatBridgePort` (структурно
 * его закрывает `DshBridge` из #004), поэтому логика покрыта тестами в Node
 * (`tests/chat-events.test.mjs`). Типы сообщений импортируются только как
 * `import type` и стираются при исполнении.
 */

import type { ChatSessionDto, ChatStreamStatus, ExtensionMessage } from './chatHtml';
import { SessionTranscriptStore } from './chatTranscript';

/** Порт моста: подписка на события и вызов методов. */
export interface ChatBridgePort {
  on(event: string, listener: (payload: unknown) => void): { dispose(): void };
  request(method: string, params: Record<string, unknown>): Promise<unknown>;
}

/** Настройки батчера токенов. */
export interface TokenBatcherOptions {
  readonly emit: (text: string) => void;
  /** Интервал сброса, мс (по умолчанию 33 ≈ 30 fps). */
  readonly flushIntervalMs?: number | undefined;
  /** Планировщик — подменяется в тестах. */
  readonly schedule?: ((callback: () => void, ms: number) => unknown) | undefined;
  /** Отмена запланированного сброса — подменяется в тестах. */
  readonly cancel?: ((handle: unknown) => void) | undefined;
}

const DEFAULT_FLUSH_INTERVAL_MS = 33;

/**
 * Копит токены и отдаёт их пачкой не чаще `flushIntervalMs`: WebView получает
 * одно сообщение на кадр вместо сотен postMessage на длинный ответ.
 */
export class TokenBatcher {
  readonly #options: TokenBatcherOptions;
  readonly #schedule: (callback: () => void, ms: number) => unknown;
  readonly #cancel: (handle: unknown) => void;
  #buffer = '';
  #handle: unknown;
  #scheduled = false;

  constructor(options: TokenBatcherOptions) {
    this.#options = options;
    this.#schedule = options.schedule ?? ((callback, ms) => setTimeout(callback, ms));
    this.#cancel = options.cancel ?? ((handle) => clearTimeout(handle as NodeJS.Timeout));
  }

  /** Добавляет токен; первый токен в окне планирует сброс. */
  push(text: string): void {
    if (text === '') {
      return;
    }
    this.#buffer += text;
    if (this.#scheduled) {
      return;
    }
    this.#scheduled = true;
    this.#handle = this.#schedule(() => {
      this.#flushNow();
    }, this.#options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS);
  }

  /** Сбрасывает накопленное немедленно (turn.done, отмена). */
  flush(): void {
    this.#flushNow();
  }

  /** Накопленный, но ещё не отправленный текст. */
  get pending(): string {
    return this.#buffer;
  }

  dispose(): void {
    if (this.#scheduled) {
      this.#cancel(this.#handle);
      this.#scheduled = false;
    }
    this.#buffer = '';
  }

  #flushNow(): void {
    if (this.#scheduled) {
      this.#cancel(this.#handle);
      this.#scheduled = false;
      this.#handle = undefined;
    }
    const text = this.#buffer;
    this.#buffer = '';
    if (text !== '') {
      this.#options.emit(text);
    }
  }
}

/** Ошибка чата с понятным сообщением. */
export class ChatControllerError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ChatControllerError';
  }
}

/** Снимок сессии для привязки чата (#024). */
export interface ChatSessionSnapshot {
  readonly sessionId: string | null;
  readonly title: string | null;
  readonly status: string;
  readonly model?: string | undefined;
  readonly preset?: string | undefined;
}

/** Порт `SessionManager` (#007) для привязки чата к сессии. */
export interface ChatSessionsPort {
  getSnapshot(): ChatSessionSnapshot;
  getDraft(sessionId: string): string;
  setDraft(sessionId: string, text: string): Promise<void> | void;
  on(
    event: 'sessionChanged' | 'statusChanged',
    listener: (snapshot: ChatSessionSnapshot) => void
  ): { dispose(): void };
}

/** Настройки контроллера чата. */
export interface ChatControllerOptions {
  readonly bridge: ChatBridgePort;
  /** Активная сессия (#007); `null` — ход начинать некуда. */
  readonly getSessionId: () => string | null;
  /** Отправка сообщения в WebView (обычно `ChatViewProvider.postMessage`). */
  readonly post: (message: ExtensionMessage) => void;
  readonly flushIntervalMs?: number | undefined;
  /** Планировщик сброса токенов — подменяется в тестах. */
  readonly schedule?: ((callback: () => void, ms: number) => unknown) | undefined;
  /** Отмена запланированного сброса — подменяется в тестах. */
  readonly cancel?: ((handle: unknown) => void) | undefined;
  readonly logger?: ((line: string) => void) | undefined;
  /** Привязка к активной сессии: история, черновик, статус (#024). */
  readonly sessions?: ChatSessionsPort | undefined;
  /** CTA «Создать сессию» из composer. */
  readonly openNewSession?: (() => void) | undefined;
}

interface TokenPayload {
  readonly sessionId?: string;
  readonly turnId?: string;
  readonly text?: string;
}

interface ToolCallPayload {
  readonly sessionId?: string;
  readonly callId?: string;
  readonly name?: string;
  readonly arguments?: Record<string, unknown>;
}

interface ToolResultPayload {
  readonly sessionId?: string;
  readonly callId?: string;
  readonly ok?: boolean;
  readonly result?: unknown;
  readonly error?: string;
}

interface TurnDonePayload {
  readonly sessionId?: string;
  readonly turnId?: string;
  readonly finishReason?: 'stop' | 'cancelled' | 'error';
}

interface ErrorPayload {
  readonly message?: string;
  readonly sessionId?: string;
}

/**
 * Связывает события `DshBridge` с сообщениями панели:
 * `token` → батчер → `chatToken`, `tool.call`/`tool.result` → блоки,
 * `turn.done`/`error` → статусы. Отмена — `turn.cancel`.
 */
export class ChatController {
  readonly #bridge: ChatBridgePort;
  readonly #getSessionId: () => string | null;
  readonly #post: (message: ExtensionMessage) => void;
  readonly #log: (line: string) => void;
  readonly #batcher: TokenBatcher;
  readonly #subscriptions: { dispose(): void }[] = [];
  readonly #sessions: ChatSessionsPort | undefined;
  readonly #transcript = new SessionTranscriptStore();
  readonly #openNewSession: (() => void) | undefined;
  #boundSessionId: string | null = null;
  /** Последний отправленный текст — для «Повторить» после ошибки. */
  #lastInput: string | null = null;
  #lastInputSessionId: string | null = null;
  #turnId: string | null = null;
  #status: ChatStreamStatus = 'idle';
  /** Отмену запросили до того, как turn.start вернул turnId. */
  #cancelRequested = false;
  #messageCounter = 0;
  #disposed = false;

  constructor(options: ChatControllerOptions) {
    this.#bridge = options.bridge;
    this.#getSessionId = options.getSessionId;
    this.#post = options.post;
    this.#log = options.logger ?? (() => undefined);
    this.#sessions = options.sessions;
    this.#openNewSession = options.openNewSession;

    this.#batcher = new TokenBatcher({
      emit: (text) => {
        this.#post({
          type: 'chatToken',
          turnId: this.#turnId ?? '',
          text
        });
      },
      flushIntervalMs: options.flushIntervalMs,
      schedule: options.schedule,
      cancel: options.cancel
    });

    this.#subscriptions.push(
      this.#bridge.on('token', (payload) => {
        const token = payload as TokenPayload;
        if (!this.#accepts(token.sessionId)) {
          return;
        }
        // Поздние токены прошлого хода не должны попадать в новый ответ.
        if (
          token.turnId !== undefined &&
          this.#turnId !== null &&
          token.turnId !== this.#turnId
        ) {
          return;
        }
        if (token.turnId !== undefined && this.#turnId === null) {
          this.#turnId = token.turnId;
        }
        if (typeof token.text === 'string') {
          if (this.#boundSessionId !== null) {
            this.#transcript.appendAssistantToken(this.#boundSessionId, token.text);
          }
          this.#batcher.push(token.text);
        }
      })
    );

    this.#subscriptions.push(
      this.#bridge.on('tool.call', (payload) => {
        const call = payload as ToolCallPayload;
        if (!this.#accepts(call.sessionId)) {
          return;
        }
        if (call.callId === undefined || call.name === undefined) {
          return;
        }
        this.#batcher.flush();
        if (this.#boundSessionId !== null) {
          this.#transcript.appendToolCall(this.#boundSessionId, {
            callId: call.callId,
            name: call.name,
            arguments: call.arguments ?? {}
          });
        }
        this.#post({
          type: 'chatToolCall',
          call: {
            id: call.callId,
            name: call.name,
            arguments: call.arguments ?? {}
          }
        });
      })
    );

    this.#subscriptions.push(
      this.#bridge.on('tool.result', (payload) => {
        const result = payload as ToolResultPayload;
        if (!this.#accepts(result.sessionId)) {
          return;
        }
        if (result.callId === undefined) {
          return;
        }
        this.#batcher.flush();
        if (this.#boundSessionId !== null) {
          this.#transcript.appendToolResult(this.#boundSessionId, {
            callId: result.callId,
            ok: result.ok ?? false,
            ...(result.result === undefined ? {} : { result: result.result }),
            ...(result.error === undefined ? {} : { error: result.error })
          });
        }
        const message: ExtensionMessage =
          result.error === undefined
            ? {
                type: 'chatToolResult',
                result: { callId: result.callId, ok: result.ok ?? false, result: result.result }
              }
            : {
                type: 'chatToolResult',
                result: {
                  callId: result.callId,
                  ok: result.ok ?? false,
                  error: result.error
                }
              };
        this.#post(message);
      })
    );

    this.#subscriptions.push(
      this.#bridge.on('turn.done', (payload) => {
        const done = payload as TurnDonePayload;
        if (!this.#accepts(done.sessionId)) {
          return;
        }
        // Старый turn.done не должен закрывать новый ход.
        if (
          done.turnId !== undefined &&
          this.#turnId !== null &&
          done.turnId !== this.#turnId
        ) {
          return;
        }
        this.#batcher.flush();
        this.#turnId = null;
        this.#cancelRequested = false;
        const finishReason = done.finishReason ?? 'stop';
        this.#status =
          finishReason === 'cancelled' ? 'cancelled' : finishReason === 'error' ? 'error' : 'idle';
        this.#post({
          type: 'chatDone',
          turnId: done.turnId ?? '',
          finishReason
        });
        this.#post({ type: 'chatStatus', status: this.#status });
      })
    );

    this.#subscriptions.push(
      this.#bridge.on('error', (payload) => {
        const error = payload as ErrorPayload;
        if (!this.#accepts(error.sessionId)) {
          return;
        }
        this.#batcher.flush();
        this.#status = 'error';
        this.#post({
          type: 'chatStatus',
          status: 'error',
          detail: error.message ?? 'ошибка DSH'
        });
      })
    );

    if (this.#sessions !== undefined) {
      this.#boundSessionId = this.#sessions.getSnapshot().sessionId;
      for (const event of ['sessionChanged', 'statusChanged'] as const) {
        this.#subscriptions.push(
          this.#sessions.on(event, () => {
            this.#syncSession();
          })
        );
      }
      // Начальная привязка: WebView получает сессию даже без события смены.
      this.#syncSession(true);
    }
  }

  /** Статус потока. */
  get status(): ChatStreamStatus {
    return this.#status;
  }

  /** Текущий ход. */
  get turnId(): string | null {
    return this.#turnId;
  }

  /**
   * Отправляет сообщение пользователя и запускает ход (`turn.start`).
   * Сообщение сразу уходит в WebView, чтобы лента не «моргала».
   */
  async send(text: string): Promise<void> {
    const trimmed = text.trim();
    if (trimmed === '') {
      return;
    }
    const sessionId = this.#getSessionId();
    if (sessionId === null) {
      throw new ChatControllerError('нет активной сессии DSH');
    }
    this.#cancelRequested = false;
    this.#lastInput = trimmed;
    this.#lastInputSessionId = sessionId;

    this.#messageCounter += 1;
    this.#transcript.appendUser(sessionId, trimmed);
    this.#post({
      type: 'message',
      message: { id: `user-${String(this.#messageCounter)}`, role: 'user', text: trimmed }
    });

    try {
      const result = (await this.#bridge.request('turn.start', {
        sessionId,
        input: trimmed
      })) as { turnId?: string };

      // Пока шёл turn.start, пользователь переключил сессию: не выставляем
      // streaming старой сессии (её токены и так отфильтруются).
      if (
        this.#sessions !== undefined &&
        this.#sessions.getSnapshot().sessionId !== sessionId
      ) {
        this.#log(`ChatController: сессия сменилась во время turn.start (${sessionId})`);
        return;
      }
      this.#turnId = result.turnId ?? null;

      // Отмену нажали, пока шёл turn.start: ход уже запущен — гасим его.
      if (this.#cancelRequested) {
        await this.#requestCancel(sessionId);
        this.#cancelRequested = false;
        this.#turnId = null;
        this.#status = 'cancelled';
        this.#post({ type: 'chatCancelled' });
        this.#post({ type: 'chatStatus', status: 'cancelled' });
        return;
      }

      this.#status = 'streaming';
      this.#post({ type: 'chatStatus', status: 'streaming' });
    } catch (error) {
      this.#status = 'error';
      this.#post({
        type: 'chatStatus',
        status: 'error',
        detail: error instanceof Error ? error.message : String(error)
      });
      throw new ChatControllerError(
        `не удалось начать ход: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error }
      );
    }
  }

  /** Отмена хода (`turn.cancel`): поток останавливается, сообщение помечается. */
  async cancel(): Promise<void> {
    const sessionId = this.#getSessionId();
    if (sessionId !== null) {
      if (this.#turnId !== null) {
        await this.#requestCancel(sessionId);
      } else {
        // Ход ещё стартует: запомним отмену, send погасит его после turn.start.
        this.#cancelRequested = true;
      }
    }
    this.#batcher.flush();
    this.#turnId = null;
    this.#status = 'cancelled';
    this.#post({ type: 'chatCancelled' });
    this.#post({ type: 'chatStatus', status: 'cancelled' });
  }

  /**
   * Сохраняет черновик composer для активной сессии (#024).
   */
  setDraft(text: string): void {
    const sessionId = this.#sessions?.getSnapshot().sessionId ?? null;
    if (sessionId === null || this.#sessions === undefined) {
      return;
    }
    void this.#sessions.setDraft(sessionId, text);
  }

  /** CTA «Создать сессию» без активной сессии. */
  requestNewSession(): void {
    this.#openNewSession?.();
  }

  /** Кнопка «Повторить»: после ошибки переотправляет последний ввод. */
  retry(): void {
    if (
      this.#status === 'error' &&
      this.#lastInput !== null &&
      this.#lastInputSessionId !== null &&
      this.#lastInputSessionId === this.#boundSessionId
    ) {
      const input = this.#lastInput;
      void this.send(input).catch((error: unknown) => {
        this.#log(
          `ChatController: повторный ход не удался: ${error instanceof Error ? error.message : String(error)}`
        );
      });
      return;
    }
    this.#syncSession(true);
  }

  /** Начальная/повторная синхронизация при готовности WebView. */
  syncNow(): void {
    this.#syncSession(true);
  }

  /** Текущая привязанная сессия (для тестов и провайдера). */
  get boundSessionId(): string | null {
    return this.#boundSessionId;
  }

  /** События принимаются только от активной сессии. */
  #accepts(sessionId: string | undefined): boolean {
    // Без порта сессий (старые тесты/каркас) фильтрации нет.
    if (this.#sessions === undefined) {
      return true;
    }
    if (this.#boundSessionId === null) {
      return true;
    }
    // Строгая политика: у активной сессии события без sessionId не принимаем
    // (иначе ошибка чужой сессии протечёт в активный чат).
    return sessionId === this.#boundSessionId;
  }

  /** Переключение сессии: история, черновик, статус (#024). */
  #syncSession(force = false): void {
    const snapshot = this.#sessions?.getSnapshot();
    if (snapshot === undefined) {
      return;
    }
    const changed = snapshot.sessionId !== this.#boundSessionId;
    if (!changed && !force) {
      this.#post({ type: 'chatSession', session: this.#sessionDto(snapshot) });
      return;
    }
    if (changed) {
      this.#batcher.flush();
      this.#turnId = null;
      this.#cancelRequested = false;
      this.#status = 'idle';
      this.#boundSessionId = snapshot.sessionId;
    }
    const records =
      snapshot.sessionId === null ? [] : this.#transcript.recordsFor(snapshot.sessionId);
    const messages =
      snapshot.sessionId === null ? [] : this.#transcript.messagesFor(snapshot.sessionId);
    this.#post({ type: 'replaceMessages', messages: [...messages] });
    for (const record of records) {
      if (record.kind === 'toolCall') {
        this.#post({
          type: 'chatToolCall',
          call: { id: record.callId, name: record.name, arguments: record.arguments }
        });
      } else if (record.kind === 'toolResult') {
        this.#post({
          type: 'chatToolResult',
          result: {
            callId: record.callId,
            ok: record.ok,
            ...(record.result === undefined ? {} : { result: record.result }),
            ...(record.error === undefined ? {} : { error: record.error })
          }
        });
      }
    }
    this.#post({ type: 'chatSession', session: this.#sessionDto(snapshot) });
    this.#post({
      type: 'composerDraft',
      text:
        snapshot.sessionId === null
          ? ''
          : (this.#sessions?.getDraft(snapshot.sessionId) ?? '')
    });
    this.#post({ type: 'chatStatus', status: 'idle' });
  }

  #sessionDto(snapshot: ChatSessionSnapshot): ChatSessionDto {
    const hasHistory =
      snapshot.sessionId !== null && this.#transcript.hasHistory(snapshot.sessionId);
    return {
      sessionId: snapshot.sessionId,
      title: snapshot.title,
      model: snapshot.model ?? '',
      preset: snapshot.preset ?? 'standard',
      status: snapshot.status,
      historyState: hasHistory ? 'replayed' : 'empty'
    };
  }

  async #requestCancel(sessionId: string): Promise<void> {
    const turnId = this.#turnId;
    if (turnId === null) {
      return;
    }
    try {
      await this.#bridge.request('turn.cancel', { sessionId, turnId });
    } catch (error) {
      this.#log(
        `ChatController: turn.cancel не удался: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /** Снимает подписки на мост и очищает батчер. */
  dispose(): void {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    for (const subscription of this.#subscriptions) {
      subscription.dispose();
    }
    this.#subscriptions.length = 0;
    this.#cancelRequested = false;
    this.#batcher.dispose();
  }
}

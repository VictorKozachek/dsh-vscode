/**
 * DshBridge — транспорт и супервизор процессов DSH.
 *
 * Схема потока:
 *
 * ```
 * spawn: dsh serve --protocol=jsonrpc --cwd <workspace> [--sandbox <mode>]
 * stdin/stdout — NDJSON (одно JSON-RPC 2.0 сообщение на строку)
 * stderr — в лог (OutputChannel «DSH»), не теряется
 * ```
 *
 * Что делает супервизор:
 *
 * - корреляция запрос/ответ по `id`, таймауты и отмена (`AbortSignal`);
 * - healthcheck `workspace.ping` после старта;
 * - экспоненциальный backoff при падении процесса;
 * - буферизация запросов, пришедших во время старта/рестарта;
 * - graceful shutdown: SIGTERM → (grace) → SIGKILL;
 * - `dispose()` снимает процесс и таймеры синхронно.
 *
 * Типы методов и событий живут в `protocol/` (#004): здесь только транспорт,
 * имена методов и событий не дублируются.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface, type Interface as ReadlineInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';

import {
  isDshEvent,
  JSONRPC_VERSION,
  WORKSPACE_PING_METHOD,
  type DshEvent,
  type DshEventPayload,
  type DshMethod,
  type DshMethodParams,
  type DshMethodResult,
  type DshSandboxMode,
  type JsonRpcErrorObject,
  type JsonRpcId
} from '@dsh-vscode/protocol';

// --- ошибки -----------------------------------------------------------------

/** Коды ошибок JSON-RPC, которыми пользуется мост. */
export const DshBridgeErrorCodes = {
  /** Таймаут, недоступный мост, отменённый запрос. */
  bridge: -32000,
  /** Метод не поддерживается клиентом. */
  methodNotFound: -32601
} as const;

/** Ошибка моста: код JSON-RPC и понятное сообщение. */
export class DshBridgeError extends Error {
  readonly code: number;
  readonly data: unknown;

  constructor(message: string, options: { code?: number; data?: unknown; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'DshBridgeError';
    this.code = options.code ?? DshBridgeErrorCodes.bridge;
    this.data = options.data;
  }
}

// --- лог и подписки ---------------------------------------------------------

/** Куда писать логи процесса (совместимо с `vscode.OutputChannel`). */
export interface DshBridgeLogger {
  appendLine(line: string): void;
}

/** Подписка, которую можно снять. */
export interface DshBridgeSubscription {
  dispose(): void;
}

/** Состояние супервизора. */
export type DshBridgeState = 'stopped' | 'starting' | 'running' | 'restarting' | 'failed';

// --- JSON-RPC peer ----------------------------------------------------------

interface PendingRequest {
  readonly method: string;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
  readonly removeAbort: (() => void) | undefined;
}

interface JsonRpcPeerOptions {
  readonly input: Readable;
  readonly output: Writable;
  readonly requestTimeoutMs: number;
  readonly log: (message: string) => void;
  readonly onNotification: (method: string, params: unknown) => void;
}

/**
 * JSON-RPC 2.0 поверх NDJSON: пишет запросы в поток, разбирает ответы и
 * уведомления сервера. Один peer = один процесс DSH.
 */
class JsonRpcPeer {
  readonly #pending = new Map<JsonRpcId, PendingRequest>();
  readonly #lines: ReadlineInterface;
  readonly #output: Writable;
  readonly #requestTimeoutMs: number;
  readonly #log: (message: string) => void;
  readonly #onNotification: (method: string, params: unknown) => void;
  #closed = false;
  #nextId = 1;
  readonly #onInputError: (error: Error) => void;
  readonly #onOutputError: (error: Error) => void;
  readonly #input: Readable;

  constructor(options: JsonRpcPeerOptions) {
    this.#output = options.output;
    this.#input = options.input;
    this.#requestTimeoutMs = options.requestTimeoutMs;
    this.#log = options.log;
    this.#onNotification = options.onNotification;

    this.#lines = createInterface({ input: options.input, crlfDelay: Infinity });
    this.#lines.on('line', (line) => {
      this.#handleLine(line);
    });

    // Ошибки потоков асинхронные: без слушателей 'error' Node роняет процесс
    // (EPIPE при записи в умерший процесс, ERR_STREAM_DESTROYED и т. п.).
    this.#onInputError = (error: Error) => {
      this.#log(`поток DSH (stdout): ${error.message}`);
    };
    this.#onOutputError = (error: Error) => {
      this.#log(`поток DSH (stdin): ${error.message}`);
      this.dispose(new DshBridgeError(`поток stdin DSH закрыт: ${error.message}`, { cause: error }));
    };
    options.input.on('error', this.#onInputError);
    options.output.on('error', this.#onOutputError);
  }

  /** Отправляет запрос и ждёт результат; таймаут и отмена — на каждой стороне. */
  request(
    method: string,
    params: unknown,
    options: { timeoutMs?: number | undefined; signal?: AbortSignal | undefined } = {}
  ): Promise<unknown> {
    if (this.#closed) {
      return Promise.reject(new DshBridgeError('мост DSH недоступен: соединение закрыто'));
    }

    const id = this.#nextId;
    this.#nextId += 1;
    const timeoutMs = options.timeoutMs ?? this.#requestTimeoutMs;

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#finish(id, {
          error: new DshBridgeError(`таймаут запроса ${method} (${String(timeoutMs)} мс)`)
        });
      }, timeoutMs);

      const pending: PendingRequest = {
        method,
        resolve,
        reject,
        timer,
        removeAbort: options.signal === undefined ? undefined : this.#watchAbort(id, method, options.signal)
      };

      if (options.signal?.aborted === true) {
        clearTimeout(timer);
        pending.removeAbort?.();
        reject(new DshBridgeError(`запрос ${method} отменён до отправки`));
        return;
      }

      this.#pending.set(id, pending);
      this.#write({ jsonrpc: JSONRPC_VERSION, id, method, params });
    });
  }

  /** Завершает peer: все висящие запросы отклоняются. */
  dispose(reason: Error): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#lines.close();
    this.#input.removeListener('error', this.#onInputError);
    this.#output.removeListener('error', this.#onOutputError);
    for (const id of [...this.#pending.keys()]) {
      this.#finish(id, { error: reason });
    }
  }

  #watchAbort(id: JsonRpcId, method: string, signal: AbortSignal): () => void {
    const listener = (): void => {
      this.#finish(id, { error: new DshBridgeError(`запрос ${method} отменён`) });
    };
    signal.addEventListener('abort', listener, { once: true });
    return () => {
      signal.removeEventListener('abort', listener);
    };
  }

  #finish(id: JsonRpcId, outcome: { error: Error } | { value: unknown }): void {
    const pending = this.#pending.get(id);
    if (pending === undefined) {
      return;
    }
    this.#pending.delete(id);
    clearTimeout(pending.timer);
    pending.removeAbort?.();
    if ('error' in outcome) {
      pending.reject(outcome.error);
    } else {
      pending.resolve(outcome.value);
    }
  }

  #write(message: Record<string, unknown>): void {
    if (this.#closed) {
      return;
    }
    try {
      this.#output.write(`${JSON.stringify(message)}\n`);
    } catch (error) {
      this.#log(`не удалось отправить сообщение в DSH: ${describeError(error)}`);
    }
  }

  #handleLine(line: string): void {
    const trimmed = line.trim();
    if (trimmed === '') {
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      this.#log(`получена не-JSON строка от DSH: ${clip(trimmed)}`);
      return;
    }
    if (!isRecord(parsed)) {
      this.#log(`получено сообщение не по схеме JSON-RPC: ${clip(trimmed)}`);
      return;
    }

    const message = parsed;
    if (message['jsonrpc'] !== JSONRPC_VERSION) {
      this.#log(`сообщение с чужой версией JSON-RPC: ${clip(trimmed)}`);
      return;
    }

    const rawId = message['id'];
    const hasId = typeof rawId === 'number' || typeof rawId === 'string';
    const method = typeof message['method'] === 'string' ? message['method'] : undefined;

    if (method === undefined) {
      this.#handleResponse(hasId ? (rawId as JsonRpcId) : null, message, trimmed);
      return;
    }

    if (hasId) {
      // Запрос от сервера: клиент умеет только уведомления, отвечаем по протоколу.
      const id = rawId as JsonRpcId;
      this.#write({
        jsonrpc: JSONRPC_VERSION,
        id,
        error: {
          code: DshBridgeErrorCodes.methodNotFound,
          message: `клиент не поддерживает метод ${method}`
        } satisfies JsonRpcErrorObject
      });
      this.#log(`DSH прислал запрос ${method}: клиент отвечает «метод не поддерживается»`);
      return;
    }

    if (!isDshEvent(method)) {
      this.#log(`неизвестное событие DSH: ${method}`);
    }
    this.#onNotification(method, message['params']);
  }

  #handleResponse(id: JsonRpcId | null, message: Record<string, unknown>, rawLine: string): void {
    if (id === null) {
      this.#log(`ответ без id: ${clip(rawLine)}`);
      return;
    }
    if (!this.#pending.has(id)) {
      this.#log(`ответ на неизвестный запрос id=${String(id)}: ${clip(rawLine)}`);
      return;
    }
    if ('error' in message) {
      this.#finish(id, { error: toBridgeError(message['error']) });
      return;
    }
    if ('result' in message) {
      this.#finish(id, { value: message['result'] });
      return;
    }
    this.#log(`ответ без result/error: ${clip(rawLine)}`);
  }
}

// --- команда запуска --------------------------------------------------------

/** Вход для сборки команды запуска `dsh serve`. */
export interface DshCommandInput {
  readonly executablePath: string;
  readonly cwd: string;
  readonly sandboxMode?: DshSandboxMode | undefined;
}

/** Готовая команда запуска процесса DSH. */
export interface DshCommand {
  readonly executable: string;
  readonly args: readonly string[];
}

/** Команда по умолчанию: `dsh serve --protocol=jsonrpc --cwd <ws> [--sandbox <mode>]`. */
export function defaultDshCommand(input: DshCommandInput): DshCommand {
  const args = ['serve', '--protocol=jsonrpc', '--cwd', input.cwd];
  if (input.sandboxMode !== undefined) {
    args.push('--sandbox', input.sandboxMode);
  }
  return { executable: input.executablePath, args };
}

// --- мост -------------------------------------------------------------------

/** Настройки супервизора. */
export interface DshBridgeOptions {
  /** Рабочая папка воркспейса. */
  readonly cwd: string;
  readonly sandboxMode?: DshSandboxMode | undefined;
  /** Путь к бинарю DSH (`dsh.executablePath`), по умолчанию `dsh` из PATH. */
  readonly executablePath?: string | undefined;
  /** Таймаут обычного запроса. */
  readonly requestTimeoutMs?: number | undefined;
  /** Таймаут healthcheck `workspace.ping`. */
  readonly healthcheckTimeoutMs?: number | undefined;
  /** Сколько ждать SIGTERM перед SIGKILL. */
  readonly shutdownGraceMs?: number | undefined;
  /** Начальная пауза перед рестартом. */
  readonly initialRestartDelayMs?: number | undefined;
  /** Множитель экспоненциального backoff. */
  readonly restartDelayFactor?: number | undefined;
  /** Потолок паузы рестарта. */
  readonly maxRestartDelayMs?: number | undefined;
  /** Сколько попыток запуска/рестарта до состояния `failed`. */
  readonly maxRestartAttempts?: number | undefined;
  /** Лог процесса и протокола (OutputChannel «DSH»). */
  readonly logger?: DshBridgeLogger | undefined;
  /** Подмена команды запуска — для тестов на фейковом сервере. */
  readonly commandBuilder?: ((input: DshCommandInput) => DshCommand) | undefined;
  /** Дополнительное окружение процесса DSH. */
  readonly environment?: NodeJS.ProcessEnv | undefined;
}

interface QueuedRequest {
  readonly method: string;
  readonly params: unknown;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
  readonly deadline: number;
  readonly signal: AbortSignal | undefined;
  removeAbort: (() => void) | undefined;
}

interface RequestOptions {
  readonly timeoutMs?: number | undefined;
  readonly signal?: AbortSignal | undefined;
}

const DEFAULT_CONSTANTS = {
  requestTimeoutMs: 30_000,
  healthcheckTimeoutMs: 5_000,
  shutdownGraceMs: 2_000,
  initialRestartDelayMs: 250,
  restartDelayFactor: 2,
  maxRestartDelayMs: 10_000,
  maxRestartAttempts: 5
} as const;

export class DshBridge {
  readonly #options: DshBridgeOptions;
  readonly #log: DshBridgeLogger;
  readonly #requestTimeoutMs: number;
  readonly #healthcheckTimeoutMs: number;
  readonly #shutdownGraceMs: number;
  readonly #maxRestartAttempts: number;

  #state: DshBridgeState = 'stopped';
  #child: ChildProcess | undefined;
  #peer: JsonRpcPeer | undefined;
  #stderrReader: ReadlineInterface | undefined;
  #restartTimer: NodeJS.Timeout | undefined;
  #restartAttempts = 0;
  #stopRequested = false;
  #disposed = false;
  #startPromise: Promise<void> | undefined;
  readonly #queue: QueuedRequest[] = [];
  readonly #processes = new Map<number, ChildProcess>();
  readonly #listeners = new Map<DshEvent, Set<(payload: unknown) => void>>();
  readonly #stateListeners = new Set<(state: DshBridgeState) => void>();

  constructor(options: DshBridgeOptions) {
    this.#options = options;
    this.#log = options.logger ?? { appendLine: () => undefined };
    this.#requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_CONSTANTS.requestTimeoutMs;
    this.#healthcheckTimeoutMs = options.healthcheckTimeoutMs ?? DEFAULT_CONSTANTS.healthcheckTimeoutMs;
    this.#shutdownGraceMs = options.shutdownGraceMs ?? DEFAULT_CONSTANTS.shutdownGraceMs;
    this.#maxRestartAttempts = options.maxRestartAttempts ?? DEFAULT_CONSTANTS.maxRestartAttempts;
  }

  /** Текущее состояние супервизора. */
  get state(): DshBridgeState {
    return this.#state;
  }

  /** Сколько процессов DSH держит мост (для диагностики и тестов). */
  get processCount(): number {
    return this.#processes.size;
  }

  /**
   * Запускает процесс DSH и дожидается healthcheck.
   * Повторяет запуск с экспоненциальным backoff до `maxRestartAttempts`.
   */
  async start(): Promise<void> {
    if (this.#disposed) {
      throw new DshBridgeError('мост DSH уже закрыт');
    }
    if (this.#state === 'running') {
      return;
    }
    if (this.#startPromise !== undefined) {
      return this.#startPromise;
    }

    this.#stopRequested = false;
    const promise = this.#startWithRetries().finally(() => {
      this.#startPromise = undefined;
    });
    this.#startPromise = promise;
    return promise;
  }

  /** Вызов метода DSH. Во время старта/рестарта запрос буферизуется. */
  async request<M extends DshMethod>(
    method: M,
    params: DshMethodParams<M>,
    options: RequestOptions = {}
  ): Promise<DshMethodResult<M>> {
    if (this.#disposed) {
      throw new DshBridgeError('мост DSH закрыт');
    }

    const timeoutMs = options.timeoutMs ?? this.#requestTimeoutMs;

    if (this.#state === 'running' && this.#peer !== undefined) {
      return (await this.#peer.request(method, params, { timeoutMs, signal: options.signal })) as DshMethodResult<M>;
    }

    if (this.#state === 'starting' || this.#state === 'restarting') {
      return (await this.#enqueue(method, params, timeoutMs, options.signal)) as DshMethodResult<M>;
    }

    throw new DshBridgeError(`мост DSH не запущен (состояние: ${this.#state})`);
  }

  /** Подписка на событие DSH (`token`, `tool.call`, …). */
  on<E extends DshEvent>(event: E, listener: (payload: DshEventPayload<E>) => void): DshBridgeSubscription {
    let listeners = this.#listeners.get(event);
    if (listeners === undefined) {
      listeners = new Set();
      this.#listeners.set(event, listeners);
    }
    const stored = listener as (payload: unknown) => void;
    listeners.add(stored);
    return {
      dispose: () => {
        listeners?.delete(stored);
      }
    };
  }

  /** Подписка на смену состояния супервизора. */
  onStateChange(listener: (state: DshBridgeState) => void): DshBridgeSubscription {
    this.#stateListeners.add(listener);
    return {
      dispose: () => {
        this.#stateListeners.delete(listener);
      }
    };
  }

  /** Graceful shutdown: SIGTERM, при необходимости SIGKILL. */
  async stop(): Promise<void> {
    if (this.#disposed) {
      return;
    }
    this.#stopRequested = true;
    this.#cancelRestart();

    const child = this.#child;
    this.#child = undefined;
    this.#stderrReader?.close();
    this.#stderrReader = undefined;
    this.#peer?.dispose(new DshBridgeError('мост DSH остановлен'));
    this.#peer = undefined;
    this.#rejectQueue(new DshBridgeError('мост DSH остановлен'));

    if (child !== undefined) {
      if (child.pid !== undefined) {
        this.#processes.delete(child.pid);
      }
      await this.#terminate(child);
    }

    this.#setState('stopped');
    this.#stopRequested = false;
  }

  /** Синхронно снимает процесс и все таймеры. */
  dispose(): void {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    this.#stopRequested = true;
    this.#cancelRestart();

    for (const child of this.#processes.values()) {
      try {
        child.kill('SIGKILL');
      } catch {
        // процесс мог уже завершиться
      }
    }
    this.#processes.clear();
    this.#child = undefined;

    this.#stderrReader?.close();
    this.#stderrReader = undefined;

    this.#peer?.dispose(new DshBridgeError('мост DSH закрыт'));
    this.#peer = undefined;

    this.#rejectQueue(new DshBridgeError('мост DSH закрыт'));
    this.#setState('stopped');
  }

  // --- внутреннее ----------------------------------------------------------

  async #startWithRetries(): Promise<void> {
    this.#setState('starting');
    let lastError: Error = new DshBridgeError('не удалось запустить процесс DSH');

    for (let attempt = 1; attempt <= this.#maxRestartAttempts; attempt += 1) {
      if (this.#disposed || this.#stopRequested) {
        throw new DshBridgeError('запуск моста DSH отменён');
      }
      try {
        await this.#spawnAndCheck();
        this.#restartAttempts = 0;
        this.#setState('running');
        this.#flushQueue();
        return;
      } catch (error) {
        lastError = error instanceof Error ? error : new DshBridgeError(String(error));
        this.#log.appendLine(
          `не удалось поднять DSH (попытка ${String(attempt)}/${String(this.#maxRestartAttempts)}): ${lastError.message}`
        );
        this.#killChild();
        if (attempt < this.#maxRestartAttempts) {
          await delay(this.#restartDelay(attempt));
        }
      }
    }

    this.#setState('failed');
    this.#rejectQueue(lastError);
    throw lastError;
  }

  async #spawnAndCheck(): Promise<void> {
    const commandBuilder = this.#options.commandBuilder ?? defaultDshCommand;
    const command = commandBuilder({
      executablePath: this.#options.executablePath ?? 'dsh',
      cwd: this.#options.cwd,
      sandboxMode: this.#options.sandboxMode
    });

    const child = spawn(command.executable, [...command.args], {
      cwd: this.#options.cwd,
      env: { ...process.env, ...this.#options.environment },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    });

    this.#child = child;
    if (child.pid !== undefined) {
      this.#processes.set(child.pid, child);
    }
    this.#log.appendLine(
      `запущен процесс DSH: ${command.executable} ${command.args.join(' ')} (pid ${String(child.pid)})`
    );

    // spawn может не состояться (нет бинаря, нет cwd, нет прав): без слушателя
    // 'error' Node валит весь extension host.
    const started = new Promise<void>((resolve, reject) => {
      child.once('spawn', () => {
        resolve();
      });
      child.once('error', (error: Error) => {
        reject(error);
      });
    });
    child.on('error', (error: Error) => {
      this.#log.appendLine(`процесс DSH: ${describeError(error)}`);
    });

    this.#attachStderr(child);
    child.once('exit', (code, signal) => {
      this.#handleExit(child, code, signal);
    });

    let spawned = false;
    try {
      await started;
      spawned = true;

      if (child.stdout === null || child.stdin === null) {
        throw new DshBridgeError('у процесса DSH нет stdio-каналов');
      }

      const peer = new JsonRpcPeer({
        input: child.stdout,
        output: child.stdin,
        requestTimeoutMs: this.#requestTimeoutMs,
        log: (message) => {
          this.#log.appendLine(`[rpc] ${message}`);
        },
        onNotification: (method, params) => {
          this.#emit(method, params);
        }
      });
      this.#peer = peer;

      await peer.request(WORKSPACE_PING_METHOD, {}, { timeoutMs: this.#healthcheckTimeoutMs });
      this.#log.appendLine('healthcheck DSH пройден (workspace.ping)');
    } catch (error) {
      this.#killChild();
      if (!spawned) {
        throw new DshBridgeError(
          `не удалось запустить процесс DSH «${command.executable}»: ${describeError(error)}`,
          { cause: error }
        );
      }
      throw new DshBridgeError(`healthcheck DSH не пройден: ${describeError(error)}`, {
        cause: error
      });
    }
  }

  #attachStderr(child: ChildProcess): void {
    if (child.stderr === null) {
      return;
    }
    const reader = createInterface({ input: child.stderr, crlfDelay: Infinity });
    reader.on('line', (line) => {
      if (line.trim() !== '') {
        this.#log.appendLine(`[stderr] ${line}`);
      }
    });
    this.#stderrReader = reader;
  }

  #handleExit(child: ChildProcess, code: number | null, signal: NodeJS.Signals | null): void {
    if (this.#child !== child) {
      return;
    }
    this.#child = undefined;
    if (child.pid !== undefined) {
      this.#processes.delete(child.pid);
    }
    this.#stderrReader?.close();
    this.#stderrReader = undefined;

    const reason = new DshBridgeError(
      `процесс DSH завершился (code=${String(code)}, signal=${String(signal)})`
    );
    this.#peer?.dispose(reason);
    this.#peer = undefined;

    if (this.#disposed || this.#stopRequested) {
      return;
    }

    if (this.#state === 'running') {
      this.#log.appendLine(`${reason.message}; перезапускаю`);
      this.#setState('restarting');
      this.#scheduleRestart();
      return;
    }

    this.#log.appendLine(`${reason.message} во время запуска`);
  }

  #scheduleRestart(): void {
    if (this.#disposed || this.#stopRequested) {
      return;
    }
    this.#restartAttempts += 1;
    if (this.#restartAttempts > this.#maxRestartAttempts) {
      const error = new DshBridgeError(
        `DSH не удалось перезапустить за ${String(this.#maxRestartAttempts)} попыток`
      );
      this.#log.appendLine(error.message);
      this.#setState('failed');
      this.#rejectQueue(error);
      return;
    }

    const delayMs = this.#restartDelay(this.#restartAttempts);
    this.#log.appendLine(`рестарт DSH через ${String(delayMs)} мс (попытка ${String(this.#restartAttempts)})`);
    this.#restartTimer = setTimeout(() => {
      this.#restartTimer = undefined;
      void this.#restart();
    }, delayMs);
  }

  async #restart(): Promise<void> {
    if (this.#disposed || this.#stopRequested) {
      return;
    }
    this.#setState('restarting');
    try {
      await this.#spawnAndCheck();
      this.#restartAttempts = 0;
      this.#setState('running');
      this.#log.appendLine('DSH перезапущен');
      this.#flushQueue();
    } catch (error) {
      this.#log.appendLine(`рестарт DSH не удался: ${describeError(error)}`);
      this.#killChild();
      this.#scheduleRestart();
    }
  }

  #restartDelay(attempt: number): number {
    const initial = this.#options.initialRestartDelayMs ?? DEFAULT_CONSTANTS.initialRestartDelayMs;
    const factor = this.#options.restartDelayFactor ?? DEFAULT_CONSTANTS.restartDelayFactor;
    const max = this.#options.maxRestartDelayMs ?? DEFAULT_CONSTANTS.maxRestartDelayMs;
    return Math.min(max, Math.round(initial * factor ** (attempt - 1)));
  }

  #cancelRestart(): void {
    if (this.#restartTimer !== undefined) {
      clearTimeout(this.#restartTimer);
      this.#restartTimer = undefined;
    }
    this.#restartAttempts = 0;
  }

  #killChild(): void {
    const child = this.#child;
    if (child === undefined) {
      return;
    }
    this.#child = undefined;
    if (child.pid !== undefined) {
      this.#processes.delete(child.pid);
    }
    this.#stderrReader?.close();
    this.#stderrReader = undefined;
    this.#peer?.dispose(new DshBridgeError('процесс DSH снимается'));
    this.#peer = undefined;
    try {
      child.kill('SIGKILL');
    } catch {
      // процесс мог уже завершиться
    }
  }

  async #terminate(child: ChildProcess): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) {
      return;
    }

    const exited = new Promise<void>((resolve) => {
      child.once('exit', () => {
        resolve();
      });
    });

    child.kill('SIGTERM');
    const killTimer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        this.#log.appendLine(`процесс DSH не завершился по SIGTERM за ${String(this.#shutdownGraceMs)} мс — SIGKILL`);
        try {
          child.kill('SIGKILL');
        } catch {
          // игнорируем: процесс мог завершиться между проверкой и kill
        }
      }
    }, this.#shutdownGraceMs);

    await exited;
    clearTimeout(killTimer);
  }

  #enqueue(
    method: string,
    params: unknown,
    timeoutMs: number,
    signal: AbortSignal | undefined
  ): Promise<unknown> {
    return new Promise<unknown>((resolve, reject) => {
      const deadline = Date.now() + timeoutMs;
      const timer = setTimeout(() => {
        const index = this.#queue.findIndex((item) => item.timer === timer);
        if (index >= 0) {
          this.#queue.splice(index, 1);
        }
        reject(
          new DshBridgeError(`таймаут запроса ${method}: мост DSH не поднялся за ${String(timeoutMs)} мс`)
        );
      }, timeoutMs);

      const queued: QueuedRequest = {
        method,
        params,
        resolve,
        reject,
        timer,
        deadline,
        signal,
        removeAbort: undefined
      };
      this.#queue.push(queued);

      if (signal !== undefined) {
        const onAbort = (): void => {
          const index = this.#queue.indexOf(queued);
          if (index >= 0) {
            this.#queue.splice(index, 1);
          }
          clearTimeout(timer);
          reject(new DshBridgeError(`запрос ${method} отменён`));
        };
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
        queued.removeAbort = () => {
          signal.removeEventListener('abort', onAbort);
        };
      }
    });
  }

  #flushQueue(): void {
    if (this.#queue.length === 0) {
      return;
    }
    const pending = this.#queue.splice(0, this.#queue.length);
    for (const item of pending) {
      clearTimeout(item.timer);
      item.removeAbort?.();
      const timeoutMs = Math.max(1, item.deadline - Date.now());
      const peer = this.#peer;
      if (peer === undefined) {
        item.reject(new DshBridgeError('мост DSH недоступен'));
        continue;
      }
      peer
        .request(item.method, item.params, { timeoutMs, signal: item.signal })
        .then(item.resolve, item.reject);
    }
  }

  #rejectQueue(error: Error): void {
    const pending = this.#queue.splice(0, this.#queue.length);
    for (const item of pending) {
      clearTimeout(item.timer);
      item.removeAbort?.();
      item.reject(error);
    }
  }

  #emit(method: string, params: unknown): void {
    if (!isDshEvent(method)) {
      return;
    }
    const listeners = this.#listeners.get(method);
    if (listeners === undefined) {
      return;
    }
    for (const listener of [...listeners]) {
      try {
        listener(params);
      } catch (error) {
        this.#log.appendLine(`обработчик события ${method} упал: ${describeError(error)}`);
      }
    }
  }

  #setState(state: DshBridgeState): void {
    if (this.#state === state) {
      return;
    }
    this.#state = state;
    for (const listener of [...this.#stateListeners]) {
      try {
        listener(state);
      } catch {
        // состояние уже сменилось; ошибки подписчиков не должны ломать супервизор
      }
    }
  }
}

// --- помощники --------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toBridgeError(value: unknown): DshBridgeError {
  if (isRecord(value)) {
    const code = typeof value['code'] === 'number' ? value['code'] : DshBridgeErrorCodes.bridge;
    const message = typeof value['message'] === 'string' ? value['message'] : 'ошибка DSH';
    return new DshBridgeError(message, { code, data: value['data'] });
  }
  return new DshBridgeError(String(value));
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function clip(text: string, maxLength = 200): string {
  return text.length <= maxLength ? text : `${text.slice(0, maxLength)}…`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

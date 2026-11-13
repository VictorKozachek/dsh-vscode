/**
 * NDJSON JSON-RPC 2.0 клиент для ACP-рантайма DSH (#021).
 *
 * Рантайм (`dsh --profile acp`) говорит построчным JSON (NDJSON) — тот же
 * формат, что и наш DshBridge; клиент держит корреляцию id, таймауты и
 * уведомления сервера. Модуль без `vscode`, тесты — через фейковый ACP-процесс.
 */

import { createInterface, type Interface as ReadlineInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';

/** Ошибка транспорта/JSON-RPC. */
export class AcpError extends Error {
  readonly code: number;
  readonly data: unknown;

  constructor(message: string, options: { code?: number; data?: unknown; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'AcpError';
    this.code = options.code ?? -32000;
    this.data = options.data;
  }
}

interface PendingRequest {
  readonly method: string;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
}

/** Настройки клиента. */
export interface AcpPeerOptions {
  readonly input: Readable;
  readonly output: Writable;
  readonly requestTimeoutMs: number;
  readonly log: (message: string) => void;
  readonly onNotification: (method: string, params: unknown) => void;
}

/** JSON-RPC 2.0 поверх NDJSON. */
export class AcpPeer {
  readonly #output: Writable;
  readonly #lines: ReadlineInterface;
  readonly #requestTimeoutMs: number;
  readonly #log: (message: string) => void;
  readonly #onNotification: (method: string, params: unknown) => void;
  readonly #pending = new Map<number, PendingRequest>();
  #nextId = 1;
  #closed = false;

  constructor(options: AcpPeerOptions) {
    this.#output = options.output;
    this.#requestTimeoutMs = options.requestTimeoutMs;
    this.#log = options.log;
    this.#onNotification = options.onNotification;
    this.#lines = createInterface({ input: options.input, crlfDelay: Infinity });
    this.#lines.on('line', (line) => {
      this.#handleLine(line);
    });
    options.input.on('error', (error: Error) => {
      this.#log(`ACP: ошибка stdout: ${error.message}`);
    });
    options.output.on('error', (error: Error) => {
      this.#log(`ACP: ошибка stdin: ${error.message}`);
      this.dispose(new AcpError(`канал в ACP закрыт: ${error.message}`, { cause: error }));
    });
  }

  /** Запрос с корреляцией id. */
  request(
    method: string,
    params: unknown,
    options: { timeoutMs?: number | undefined } = {}
  ): Promise<unknown> {
    if (this.#closed) {
      return Promise.reject(new AcpError('ACP-рантайм недоступен: соединение закрыто'));
    }
    const id = this.#nextId;
    this.#nextId += 1;
    const timeoutMs = options.timeoutMs ?? this.#requestTimeoutMs;

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#finish(id, new AcpError(`таймаут запроса ${method} (${String(timeoutMs)} мс)`));
      }, timeoutMs);

      this.#pending.set(id, { method, resolve, reject, timer });
      this.#write({ jsonrpc: '2.0', id, method, params });
    });
  }

  /** Уведомление без ответа. */
  notify(method: string, params: unknown): void {
    if (this.#closed) {
      return;
    }
    this.#write({ jsonrpc: '2.0', method, params });
  }

  /** Закрывает клиент; висящие запросы отклоняются. */
  dispose(reason: Error): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#lines.close();
    for (const id of [...this.#pending.keys()]) {
      this.#finish(id, reason);
    }
  }

  #finish(id: number, error?: Error, value?: unknown): void {
    const pending = this.#pending.get(id);
    if (pending === undefined) {
      return;
    }
    this.#pending.delete(id);
    clearTimeout(pending.timer);
    if (error !== undefined) {
      pending.reject(error);
    } else {
      pending.resolve(value);
    }
  }

  #write(message: Record<string, unknown>): void {
    if (this.#closed) {
      return;
    }
    try {
      this.#output.write(`${JSON.stringify(message)}\n`);
    } catch (error) {
      this.#log(`ACP: не удалось отправить сообщение: ${describeError(error)}`);
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
      this.#log(`ACP: не-JSON строка: ${trimmed.slice(0, 200)}`);
      return;
    }
    if (!isRecord(parsed) || parsed['jsonrpc'] !== '2.0') {
      this.#log('ACP: сообщение не по схеме JSON-RPC');
      return;
    }

    const rawId = parsed['id'];
    const id = typeof rawId === 'number' ? rawId : typeof rawId === 'string' ? Number(rawId) : undefined;
    const method = typeof parsed['method'] === 'string' ? parsed['method'] : undefined;

    if (method === undefined) {
      if (id === undefined || !this.#pending.has(id)) {
        return;
      }
      if ('error' in parsed && isRecord(parsed['error'])) {
        const error = parsed['error'];
        this.#finish(
          id,
          new AcpError(
            typeof error['message'] === 'string' ? error['message'] : 'ACP вернул ошибку',
            { code: typeof error['code'] === 'number' ? error['code'] : -32000, data: error['data'] }
          )
        );
        return;
      }
      this.#finish(id, undefined, parsed['result']);
      return;
    }

    // Запрос от сервера (агент → клиент): клиент поддерживает только
    // уведомления и permission-запросы считает отказом.
    if (id !== undefined) {
      this.#write({
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: `клиент не поддерживает метод ${method}` }
      });
      return;
    }

    this.#onNotification(method, parsed['params']);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

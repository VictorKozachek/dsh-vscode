/**
 * Терминал-мост (#015): выполнение команд агента через shell integration.
 *
 * Безопасность: каждая команда проходит approval-порт (#009); без allow
 * команда не выполняется. Вывод буферизуется с лимитом, есть таймаут и
 * отмена. Чистые порты — тесты `tests/terminal-bridge.test.mjs`.
 */

export type TerminalRunStatus =
  | 'ok'
  | 'denied'
  | 'timeout'
  | 'no-shell-integration'
  | 'error';

export interface TerminalRunResult {
  readonly status: TerminalRunStatus;
  readonly output: string;
  readonly exitCode: number | undefined;
  readonly truncated: boolean;
  readonly durationMs: number;
  readonly error?: string | undefined;
}

export interface TerminalExecution {
  /** Поток вывода команды (stdout+stderr). */
  read(): AsyncIterable<string>;
  /** Код возврата; может не прийти — таймаут. */
  readonly exitCode: Promise<number | undefined>;
}

export interface TerminalSession {
  readonly shellIntegrationAvailable: boolean;
  execute(command: string): TerminalExecution | undefined;
  dispose(): void;
}

export interface TerminalApprovalPort {
  request(input: {
    readonly sessionId: string;
    readonly tool: string;
    readonly command: string;
    readonly cwd: string | undefined;
  }): Promise<'allow' | 'allow-session' | 'deny'>;
}

export interface TerminalBridgeOptions {
  readonly createSession: (input: {
    readonly cwd: string | undefined;
    readonly name: string;
  }) => Promise<TerminalSession> | TerminalSession;
  readonly approval: TerminalApprovalPort;
  readonly timeoutMs?: number | undefined;
  readonly maxOutputBytes?: number | undefined;
  readonly now?: (() => Date) | undefined;
  readonly log?: ((line: string) => void) | undefined;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BYTES = 64 * 1024;

/** Буфер вывода с лимитом байт и признаком усечения. */
export class OutputBuffer {
  readonly #maxBytes: number;
  #text = '';
  #bytes = 0;
  #truncated = false;

  constructor(maxBytes: number = DEFAULT_MAX_BYTES) {
    this.#maxBytes = maxBytes;
  }

  append(chunk: string): void {
    if (this.#truncated) {
      return;
    }
    const chunkBytes = Buffer.byteLength(chunk, 'utf8');
    if (this.#bytes + chunkBytes > this.#maxBytes) {
      const available = Math.max(0, this.#maxBytes - this.#bytes);
      if (available > 0) {
        // Обрезаем по байтам, не рвя UTF-8: декодируем допустимый префикс.
        const sliced = Buffer.from(chunk, 'utf8').subarray(0, available).toString('utf8');
        this.#text += sliced;
        this.#bytes += Buffer.byteLength(sliced, 'utf8');
      }
      this.#truncated = true;
      return;
    }
    this.#text += chunk;
    this.#bytes += chunkBytes;
  }

  get text(): string {
    return this.#text;
  }

  get bytes(): number {
    return this.#bytes;
  }

  get truncated(): boolean {
    return this.#truncated;
  }
}

/** Выполняет команду агента; возвращает вывод и код возврата. */
export class TerminalBridge {
  readonly #options: TerminalBridgeOptions;
  readonly #timeoutMs: number;
  #cancel: (() => void) | undefined;

  constructor(options: TerminalBridgeOptions) {
    this.#options = options;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** Отменяет текущую команду (если выполняется). */
  cancel(): void {
    this.#cancel?.();
  }

  async run(input: {
    readonly sessionId: string;
    readonly command: string;
    readonly cwd?: string | undefined;
  }): Promise<TerminalRunResult> {
    const started = Date.now();
    const command = input.command.trim();
    if (command === '') {
      return this.#result('error', '', undefined, started, 'пустая команда');
    }

    const decision = await this.#options.approval.request({
      sessionId: input.sessionId,
      tool: 'run_command',
      command,
      cwd: input.cwd
    });
    if (decision !== 'allow' && decision !== 'allow-session') {
      this.#options.log?.('терминал: команда отклонена approval-политикой');
      return this.#result('denied', '', undefined, started);
    }

    const session = await this.#options.createSession({
      cwd: input.cwd,
      name: `DSH: ${command.slice(0, 40)}`
    });
    try {
      if (!session.shellIntegrationAvailable) {
        return this.#result(
          'no-shell-integration',
          '',
          undefined,
          started,
          'shell integration недоступна — команда не выполнена'
        );
      }
      const execution = session.execute(command);
      if (execution === undefined) {
        return this.#result('error', '', undefined, started, 'команда не запущена');
      }

      const buffer = new OutputBuffer(this.#options.maxOutputBytes);
      let timedOut = false;
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => {
          timedOut = true;
          resolve('timeout');
        }, this.#timeoutMs);
      });
      const cancel = new Promise<'cancelled'>((resolve) => {
        this.#cancel = () => {
          resolve('cancelled');
        };
      });

      const reading = (async (): Promise<number | undefined> => {
        for await (const chunk of execution.read()) {
          buffer.append(chunk);
        }
        return execution.exitCode;
      })();

      const outcome = await Promise.race([reading, timeout, cancel]);
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      this.#cancel = undefined;

      if (outcome === 'timeout' || outcome === 'cancelled') {
        return this.#result(
          timedOut ? 'timeout' : 'error',
          buffer.text,
          undefined,
          started,
          timedOut ? `таймаут ${String(this.#timeoutMs)} мс` : 'команда отменена',
          buffer.truncated
        );
      }
      return this.#result(
        'ok',
        buffer.text,
        typeof outcome === 'number' ? outcome : undefined,
        started,
        undefined,
        buffer.truncated
      );
    } catch (error) {
      return this.#result(
        'error',
        '',
        undefined,
        started,
        error instanceof Error ? error.message : String(error)
      );
    } finally {
      session.dispose();
      this.#cancel = undefined;
    }
  }

  #result(
    status: TerminalRunStatus,
    output: string,
    exitCode: number | undefined,
    started: number,
    error?: string,
    truncated = false
  ): TerminalRunResult {
    return {
      status,
      output,
      exitCode,
      truncated,
      durationMs: Date.now() - started,
      ...(error === undefined ? {} : { error })
    };
  }
}

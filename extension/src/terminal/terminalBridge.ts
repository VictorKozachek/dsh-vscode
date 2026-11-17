/**
 * Терминал-мост (#015): ACP terminal client — асинхронный handle.
 *
 * `start()` сразу возвращает handle: `output()` отдаёт текущий буфер,
 * `waitForExit()` ждёт завершения, `kill()/release()` останавливают процесс.
 * Каждая команда проходит approval-порт (#009); без allow не выполняется.
 */

export type TerminalRunStatus =
  | 'started'
  | 'denied'
  | 'timeout'
  | 'cancelled'
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
  read(): AsyncIterable<string>;
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

export interface TerminalHandle {
  readonly status: TerminalRunStatus;
  output(): { readonly text: string; readonly truncated: boolean };
  waitForExit(): Promise<number | undefined>;
  kill(): void;
  release(): void;
  readonly error?: string | undefined;
}

export interface TerminalBridgeOptions {
  readonly createSession: (input: {
    readonly cwd: string | undefined;
    readonly name: string;
    readonly env?: Readonly<Record<string, string>> | undefined;
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

/** Выполняет команды агента; `start()` — асинхронный handle для ACP. */
export class TerminalBridge {
  readonly #options: TerminalBridgeOptions;
  readonly #timeoutMs: number;
  #active: TerminalHandle | undefined;

  constructor(options: TerminalBridgeOptions) {
    this.#options = options;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  cancel(): void {
    this.#active?.kill();
  }

  /** Запускает команду и возвращает handle, не дожидаясь завершения. */
  async start(input: {
    readonly sessionId: string;
    readonly command: string;
    readonly cwd?: string | undefined;
    readonly env?: Readonly<Record<string, string>> | undefined;
    readonly maxOutputBytes?: number | undefined;
  }): Promise<TerminalHandle> {
    const command = input.command.trim();
    if (command === '') {
      return this.#finished('error', undefined, 'пустая команда');
    }
    const decision = await this.#options.approval.request({
      sessionId: input.sessionId,
      tool: 'run_command',
      command,
      cwd: input.cwd
    });
    if (decision !== 'allow' && decision !== 'allow-session') {
      this.#options.log?.('терминал: команда отклонена approval-политикой');
      return this.#finished('denied');
    }

    const session = await this.#options.createSession({
      cwd: input.cwd,
      name: `DSH: ${command.slice(0, 40)}`,
      ...(input.env === undefined ? {} : { env: input.env })
    });
    if (!session.shellIntegrationAvailable) {
      session.dispose();
      return this.#finished(
        'no-shell-integration',
        undefined,
        'shell integration недоступна — команда не выполнена'
      );
    }
    const execution = session.execute(command);
    if (execution === undefined) {
      session.dispose();
      return this.#finished('error', undefined, 'команда не запущена');
    }

    const buffer = new OutputBuffer(input.maxOutputBytes ?? this.#options.maxOutputBytes);
    let status: TerminalRunStatus = 'started';
    let error: string | undefined;
    let settled = false;
    let resolveExit: (value: number | undefined) => void = () => undefined;
    const exit = new Promise<number | undefined>((resolve) => {
      resolveExit = resolve;
    });
    const timerRef: { value?: NodeJS.Timeout } = {};

    const finish = (next: TerminalRunStatus, code: number | undefined, err?: string): void => {
      if (settled) {
        return;
      }
      settled = true;
      status = next;
      if (err !== undefined) {
        error = err;
      }
      if (timerRef.value !== undefined) {
        clearTimeout(timerRef.value);
      }
      session.dispose();
      resolveExit(code);
    };

    const handle: TerminalHandle = {
      get status() {
        return status;
      },
      get error() {
        return error;
      },
      output: () => ({ text: buffer.text, truncated: buffer.truncated }),
      waitForExit: () => exit,
      kill: () => finish('cancelled', undefined, 'команда отменена'),
      release: () => finish('cancelled', undefined, 'команда освобождена')
    };
    this.#active = handle;
    timerRef.value = setTimeout(() => {
      finish('timeout', undefined, `таймаут ${String(this.#timeoutMs)} мс`);
    }, this.#timeoutMs);

    void (async () => {
      try {
        for await (const chunk of execution.read()) {
          if (settled) {
            break;
          }
          buffer.append(chunk);
        }
        const code = await execution.exitCode;
        finish('started', code);
      } catch (cause) {
        finish('error', undefined, cause instanceof Error ? cause.message : String(cause));
      }
    })();

    return handle;
  }

  /** Удобный блокирующий вызов (unit/CLI): start + waitForExit. */
  async run(input: {
    readonly sessionId: string;
    readonly command: string;
    readonly cwd?: string | undefined;
    readonly env?: Readonly<Record<string, string>> | undefined;
    readonly maxOutputBytes?: number | undefined;
  }): Promise<TerminalRunResult> {
    const started = Date.now();
    const handle = await this.start(input);
    const exitCode = await handle.waitForExit();
    const output = handle.output();
    return {
      status: handle.status === 'started' ? 'ok' : handle.status,
      output: output.text,
      exitCode,
      truncated: output.truncated,
      durationMs: Date.now() - started,
      ...(handle.error === undefined ? {} : { error: handle.error })
    } as TerminalRunResult;
  }

  #finished(
    status: TerminalRunStatus,
    exitCode?: number | undefined,
    error?: string | undefined
  ): TerminalHandle {
    return {
      status,
      output: () => ({ text: '', truncated: false }),
      waitForExit: () => Promise.resolve(exitCode),
      kill: () => undefined,
      release: () => undefined,
      ...(error === undefined ? {} : { error })
    };
  }
}

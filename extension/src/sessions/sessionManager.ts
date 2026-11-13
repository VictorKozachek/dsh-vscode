/**
 * SessionManager — жизненный цикл сессий DSH из расширения.
 *
 * Отвечает за create/resume/list/pause через `DshBridge` (#004), хранение
 * активной сессии на воркспейс (реестр #003) и черновиков (`workspaceState`),
 * восстановление после рестарта Extension Host и события наружу
 * (`sessionChanged`, `statusChanged`) для статус-бара и панели.
 *
 * Мост и хранилища подключаются через узкие порты (`DshBridgePort`,
 * `MementoPort`, `SessionPersistencePort`): модуль не импортирует `vscode`,
 * а `DshBridge` структурно удовлетворяет `DshBridgePort` — проводка живёт в
 * активации расширения (#011).
 *
 * Модуль без относительных импортов: тесты исполняют его в Node напрямую
 * (`tests/session-manager.test.mjs`), а типы протокола импортируются только как
 * `import type` и стираются при исполнении.
 */

import type {
  DshEvent,
  DshEventPayload,
  DshMethod,
  DshMethodParams,
  DshMethodResult,
  DshSandboxMode,
  DshSessionSummary
} from '@dsh-vscode/protocol';

/** Состояние сессии для UI. */
export type SessionStatus = 'idle' | 'active' | 'paused' | 'restoring' | 'offline';

/** Подписка, которую можно снять. */
export interface SessionSubscription {
  dispose(): void;
}

/**
 * Порт моста DSH — подмножество публичного API `DshBridge` (#004).
 * Реальный мост подходит сюда структурно, тесты подставляют мок.
 */
export interface DshBridgePort {
  start(): Promise<void>;
  stop(): Promise<void>;
  request<M extends DshMethod>(
    method: M,
    params: DshMethodParams<M>,
    options?: { timeoutMs?: number | undefined; signal?: AbortSignal | undefined }
  ): Promise<DshMethodResult<M>>;
  on<E extends DshEvent>(
    event: E,
    listener: (payload: DshEventPayload<E>) => void
  ): SessionSubscription;
}

/** Порт `vscode.Memento` (`ExtensionContext.workspaceState`). */
export interface MementoPort {
  get<T>(key: string, defaultValue?: T): T | undefined;
  update(key: string, value: unknown): PromiseLike<void> | void;
}

/** Порт реестра воркспейсов (#003): активная сессия на воркспейс. */
export interface SessionPersistencePort {
  readLastSession(workspaceId: string): Promise<string | null>;
  writeLastSession(
    workspaceId: string,
    sessionId: string | null,
    updatedAt: string
  ): Promise<void>;
}

/** Снимок состояния менеджера (то, что уходит в UI). */
export interface SessionSnapshot {
  readonly workspaceId: string;
  readonly sessionId: string | null;
  readonly title: string | null;
  readonly status: SessionStatus;
  readonly turnId: string | null;
  readonly updatedAt: string;
}

/** События менеджера наружу. */
export type SessionManagerEvent = 'sessionChanged' | 'statusChanged';

/** Ошибка менеджера сессий. */
export class SessionManagerError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'SessionManagerError';
  }
}

/** Настройки менеджера. */
export interface SessionManagerOptions {
  readonly workspaceId: string;
  readonly bridge: DshBridgePort;
  /** `workspaceState`: черновики и резервная копия последней сессии. */
  readonly storage?: MementoPort | undefined;
  /** Реестр воркспейсов (#003) — приоритетный источник последней сессии. */
  readonly persistence?: SessionPersistencePort | undefined;
  readonly logger?: ((line: string) => void) | undefined;
  readonly clock?: (() => Date) | undefined;
}

const DRAFT_KEY_PREFIX = 'dsh.draft.';
const LAST_SESSION_KEY_PREFIX = 'dsh.session.last.';

/**
 * Менеджер сессий воркспейса. Публичные операции сериализуются: гонка
 * `create`/`resume` (двойная активация, быстрый двойной клик) не создаёт
 * дублей — второй вызов видит уже активную сессию.
 */
export class SessionManager {
  readonly #workspaceId: string;
  readonly #bridge: DshBridgePort;
  readonly #storage: MementoPort | undefined;
  readonly #persistence: SessionPersistencePort | undefined;
  readonly #log: (line: string) => void;
  readonly #clock: () => Date;

  #sessionId: string | null = null;
  #title: string | null = null;
  #status: SessionStatus = 'idle';
  #turnId: string | null = null;
  #updatedAt: string;
  #chain: Promise<unknown> = Promise.resolve();
  #listeners = new Map<SessionManagerEvent, Set<(snapshot: SessionSnapshot) => void>>();
  readonly #bridgeSubscriptions: SessionSubscription[] = [];
  #disposed = false;

  constructor(options: SessionManagerOptions) {
    this.#workspaceId = options.workspaceId;
    this.#bridge = options.bridge;
    this.#storage = options.storage;
    this.#persistence = options.persistence;
    this.#log = options.logger ?? (() => undefined);
    this.#clock = options.clock ?? (() => new Date());
    this.#updatedAt = this.#clock().toISOString();

    this.#bridgeSubscriptions.push(
      this.#bridge.on('turn.done', (payload) => {
        if (payload.turnId === this.#turnId) {
          this.#turnId = null;
          this.#status = this.#sessionId === null ? 'idle' : 'active';
          this.#touch();
        }
      })
    );
    this.#bridgeSubscriptions.push(
      this.#bridge.on('error', (payload) => {
        this.#log(`SessionManager: ошибка DSH — ${payload.message}`);
      })
    );
  }

  /** Идентификатор воркспейса. */
  get workspaceId(): string {
    return this.#workspaceId;
  }

  /** Текущий снимок состояния. */
  get state(): SessionSnapshot {
    return {
      workspaceId: this.#workspaceId,
      sessionId: this.#sessionId,
      title: this.#title,
      status: this.#status,
      turnId: this.#turnId,
      updatedAt: this.#updatedAt
    };
  }

  /**
   * Восстановление после рестарта IDE: `session.resume` последней сессии, если
   * её помнит реестр; если DSH её не знает — создаётся новая, причина пишется
   * в лог. Повторный вызов при активной сессии ничего не делает (без дублей).
   */
  async restore(): Promise<SessionSnapshot> {
    return this.#run(async () => {
      if (this.#sessionId !== null && this.#status === 'active') {
        return this.state;
      }

      this.#status = 'restoring';
      this.#touch();
      await this.#ensureBridge();

      const lastSessionId = await this.#readLastSessionId();
      if (lastSessionId !== null) {
        let resumeError: unknown;
        try {
          const resumed = await this.#bridge.request('session.resume', { sessionId: lastSessionId });
          this.#applySession(resumed.session.id, resumed.session.title ?? null);
        } catch (error) {
          resumeError = error;
        }

        if (resumeError === undefined) {
          this.#status = 'active';
          await this.#persistSession();
          this.#touch();
          this.#log(`SessionManager: сессия ${lastSessionId} восстановлена`);
          return this.state;
        }

        // Ошибка resume может быть временной (таймаут, обрыв): создавать новую
        // сессию можно только если DSH её действительно не знает.
        const exists = await this.#sessionExistsOnServer(lastSessionId);
        if (exists === true) {
          this.#status = 'idle';
          this.#touch();
          throw new SessionManagerError(
            `не удалось возобновить сессию ${lastSessionId}: ${describeError(resumeError)}`,
            { cause: resumeError }
          );
        }
        if (exists === null) {
          this.#status = 'offline';
          this.#touch();
          throw new SessionManagerError(
            `мост DSH недоступен при проверке сессии ${lastSessionId}: ${describeError(resumeError)}`,
            { cause: resumeError }
          );
        }
        this.#log(
          `SessionManager: сессия ${lastSessionId} не найдена на стороне DSH (${describeError(resumeError)}), создаю новую`
        );
      }

      return this.#createLocked();
    });
  }

  /** Создаёт новую сессию (`DSH: New Session`). */
  async create(
    options: {
      title?: string;
      model?: string;
      preset?: string;
      sandbox?: DshSandboxMode;
      approval?: 'ask' | 'auto' | 'never';
    } = {}
  ): Promise<SessionSnapshot> {
    return this.#run(async () => {
      await this.#ensureBridge();
      return this.#createLocked(options);
    });
  }

  /** Возобновляет конкретную сессию (`DSH: Resume Last Session` — через restore). */
  async resume(sessionId: string): Promise<SessionSnapshot> {
    return this.#run(async () => {
      await this.#ensureBridge();
      try {
        const resumed = await this.#bridge.request('session.resume', { sessionId });
        this.#applySession(resumed.session.id, resumed.session.title ?? null);
        this.#status = 'active';
        await this.#persistSession();
        this.#touch();
        return this.state;
      } catch (error) {
        throw new SessionManagerError(
          `не удалось возобновить сессию ${sessionId}: ${describeError(error)}`,
          { cause: error }
        );
      }
    });
  }

  /** Список сессий воркспейса. */
  async list(): Promise<readonly DshSessionSummary[]> {
    return this.#run(async () => {
      await this.#ensureBridge();
      const result = await this.#bridge.request('session.list', {
        workspaceId: this.#workspaceId
      });
      return result.sessions;
    });
  }

  /** Начинает ход в активной сессии (используется панелью, #008). */
  async startTurn(input: string): Promise<string> {
    return this.#run(async () => {
      const sessionId = this.#requireSession();
      await this.#ensureBridge();
      const result = await this.#bridge.request('turn.start', { sessionId, input });
      this.#turnId = result.turnId;
      this.#status = 'active';
      this.#touch();
      return result.turnId;
    });
  }

  /**
   * Пауза (`DSH: Stop Agent`): отменяет текущий ход через `turn.cancel`,
   * сессия остаётся активной в списке.
   */
  async pause(): Promise<SessionSnapshot> {
    return this.#run(async () => {
      const sessionId = this.#requireSession();
      const turnId = this.#turnId;
      if (turnId !== null) {
        try {
          await this.#bridge.request('turn.cancel', { sessionId, turnId });
        } catch (error) {
          // Ход на DSH может продолжаться: не врём UI статусом paused.
          this.#log(`SessionManager: turn.cancel не удался: ${describeError(error)}`);
          throw new SessionManagerError(
            `не удалось остановить ход ${turnId}: ${describeError(error)}`,
            { cause: error }
          );
        }
      }
      this.#turnId = null;
      this.#status = 'paused';
      this.#touch();
      return this.state;
    });
  }

  /** Синоним `pause()` для команды `DSH: Stop Agent`. */
  async stop(): Promise<SessionSnapshot> {
    return this.pause();
  }

  /** Черновик composer'а из `workspaceState`. */
  getDraft(): string {
    return this.#storage?.get<string>(`${DRAFT_KEY_PREFIX}${this.#workspaceId}`, '') ?? '';
  }

  /** Сохранение черновика composer'а (переживает рестарт IDE). */
  async setDraft(text: string): Promise<void> {
    if (this.#storage === undefined) {
      return;
    }
    await this.#storage.update(`${DRAFT_KEY_PREFIX}${this.#workspaceId}`, text);
  }

  /** Подписка на события. */
  on(event: SessionManagerEvent, listener: (snapshot: SessionSnapshot) => void): SessionSubscription {
    let listeners = this.#listeners.get(event);
    if (listeners === undefined) {
      listeners = new Set();
      this.#listeners.set(event, listeners);
    }
    listeners.add(listener);
    return {
      dispose: () => {
        listeners?.delete(listener);
      }
    };
  }

  /** Снимает подписки на мост и события. */
  dispose(): void {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    for (const subscription of this.#bridgeSubscriptions) {
      subscription.dispose();
    }
    this.#bridgeSubscriptions.length = 0;
    this.#listeners.clear();
  }

  // --- внутреннее ----------------------------------------------------------

  async #createLocked(
    options: {
      title?: string;
      model?: string;
      preset?: string;
      sandbox?: DshSandboxMode;
      approval?: 'ask' | 'auto' | 'never';
    } = {}
  ): Promise<SessionSnapshot> {
    let created: { sessionId: string };
    try {
      created = await this.#bridge.request('session.create', {
        workspaceId: this.#workspaceId,
        ...(options.title === undefined ? {} : { title: options.title }),
        ...(options.model === undefined ? {} : { model: options.model }),
        ...(options.preset === undefined ? {} : { preset: options.preset }),
        ...(options.sandbox === undefined ? {} : { sandbox: options.sandbox }),
        ...(options.approval === undefined ? {} : { approval: options.approval })
      });
    } catch (error) {
      this.#status = 'offline';
      this.#touch();
      throw new SessionManagerError(`не удалось создать сессию: ${describeError(error)}`, {
        cause: error
      });
    }

    this.#applySession(created.sessionId, options.title ?? null);
    this.#status = 'active';
    // Ошибка записи в реестр не делает созданную сессию недействительной.
    await this.#persistSession();
    this.#touch();
    this.#log(`SessionManager: создана сессия ${created.sessionId}`);
    return this.state;
  }

  async #ensureBridge(): Promise<void> {
    try {
      await this.#bridge.start();
    } catch (error) {
      this.#status = 'offline';
      this.#touch();
      throw new SessionManagerError(`мост DSH недоступен: ${describeError(error)}`, { cause: error });
    }
  }

  #applySession(sessionId: string, title: string | null): void {
    this.#sessionId = sessionId;
    this.#title = title;
    this.#turnId = null;
  }

  #requireSession(): string {
    if (this.#sessionId === null) {
      throw new SessionManagerError('активной сессии нет');
    }
    return this.#sessionId;
  }

  async #readLastSessionId(): Promise<string | null> {
    if (this.#persistence !== undefined) {
      const stored = await this.#persistence.readLastSession(this.#workspaceId);
      if (stored !== null) {
        return stored;
      }
    }
    const fallback = this.#storage?.get<string>(`${LAST_SESSION_KEY_PREFIX}${this.#workspaceId}`);
    return fallback ?? null;
  }

  async #persistSession(): Promise<void> {
    // Время открытия — момент записи, а не конструктора/предыдущего события:
    // по нему реестр #003 сортирует записи и делает GC.
    const updatedAt = this.#clock().toISOString();
    this.#updatedAt = updatedAt;

    if (this.#persistence !== undefined) {
      try {
        await this.#persistence.writeLastSession(this.#workspaceId, this.#sessionId, updatedAt);
      } catch (error) {
        this.#log(
          `SessionManager: не удалось сохранить сессию ${String(this.#sessionId)} в реестре: ${describeError(error)}`
        );
      }
    }
    if (this.#storage !== undefined) {
      try {
        await this.#storage.update(`${LAST_SESSION_KEY_PREFIX}${this.#workspaceId}`, this.#sessionId);
      } catch (error) {
        this.#log(`SessionManager: не удалось сохранить сессию в workspaceState: ${describeError(error)}`);
      }
    }
  }

  /** Знает ли DSH сессию: `null` — проверить не удалось (мост недоступен). */
  async #sessionExistsOnServer(sessionId: string): Promise<boolean | null> {
    try {
      const result = await this.#bridge.request('session.list', {
        workspaceId: this.#workspaceId
      });
      return result.sessions.some((session) => session.id === sessionId);
    } catch (error) {
      this.#log(`SessionManager: session.list для проверки ${sessionId} не удался: ${describeError(error)}`);
      return null;
    }
  }

  #touch(): void {
    this.#updatedAt = this.#clock().toISOString();
    const snapshot = this.state;
    this.#emit('sessionChanged', snapshot);
    this.#emit('statusChanged', snapshot);
  }

  #emit(event: SessionManagerEvent, snapshot: SessionSnapshot): void {
    const listeners = this.#listeners.get(event);
    if (listeners === undefined) {
      return;
    }
    for (const listener of [...listeners]) {
      try {
        listener(snapshot);
      } catch (error) {
        this.#log(`SessionManager: обработчик ${event} упал: ${describeError(error)}`);
      }
    }
  }

  /** Сериализация публичных операций: без гонок и дублей сессий. */
  #run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#chain.then(operation, operation);
    this.#chain = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }
}

// --- команды ----------------------------------------------------------------

/** Куда команды показывают результат. */
export interface SessionCommandsUi {
  readonly notify: (message: string) => void | PromiseLike<unknown>;
}

/** Настройки команд. */
export interface SessionCommandsOptions {
  /** Менеджер появляется после подключения моста и воркспейса (#011). */
  readonly getManager: () => SessionManager | null;
  readonly ui: SessionCommandsUi;
}

/** Обработчики трёх команд панели. */
export interface SessionCommands {
  newSession(): Promise<void>;
  resumeLast(): Promise<void>;
  stopAgent(): Promise<void>;
}

/**
 * `DSH: New Session`, `DSH: Resume Last Session`, `DSH: Stop Agent`:
 * тонкая обвязка над менеджером с понятными сообщениями.
 */
export function createSessionCommands(options: SessionCommandsOptions): SessionCommands {
  const run = async (label: string, action: (manager: SessionManager) => Promise<string>): Promise<void> => {
    const manager = options.getManager();
    if (manager === null) {
      await options.ui.notify(`${label}: мост DSH не подключён (задача #011).`);
      return;
    }
    try {
      await options.ui.notify(await action(manager));
    } catch (error) {
      await options.ui.notify(`${label}: ${describeError(error)}`);
    }
  };

  return {
    async newSession() {
      await run('DSH: New Session', async (manager) => {
        const snapshot = await manager.create();
        return `DSH: New Session — сессия ${String(snapshot.sessionId)} создана.`;
      });
    },
    async resumeLast() {
      await run('DSH: Resume Last Session', async (manager) => {
        const snapshot = await manager.restore();
        return `DSH: Resume Last Session — сессия ${String(snapshot.sessionId)} восстановлена.`;
      });
    },
    async stopAgent() {
      await run('DSH: Stop Agent', async (manager) => {
        const snapshot = await manager.stop();
        return `DSH: Stop Agent — ход отменён, сессия ${String(snapshot.sessionId)} на паузе.`;
      });
    }
  };
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

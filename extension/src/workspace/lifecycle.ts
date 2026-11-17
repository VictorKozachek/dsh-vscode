/**
 * Lifecycle воркспейса (#011): смена папки переключает контекст и сессии.
 *
 * Машина состояний: `resolving → loading-context → ready → paused → teardown`.
 * Переключение A→B: сессия A ставится на паузу и остаётся живой на grace period
 * (по умолчанию 10 минут) — быстрый возврат возобновляет её мгновенно, без
 * запуска процесса. По истечении grace — shutdown и GC. События старого
 * воркспейса отбрасываются по id (`acceptsEvent`).
 *
 * Модуль без `vscode`: таймеры, создание рантайма и загрузка контекста —
 * порты, поэтому сценарии проверяются fake timers в
 * `tests/workspace-lifecycle.test.mjs`.
 */

/** Состояние воркспейса. */
export type LifecycleState = 'resolving' | 'loading-context' | 'ready' | 'paused' | 'teardown';

/** Папка воркспейса (id — стабильный идентификатор записи реестра). */
export interface WorkspaceFolderRef {
  readonly id: string;
  readonly path: string;
}

/** Рантайм одного воркспейса: мост DSH, менеджер сессий, загрузчик контекста. */
export interface WorkspaceRuntime {
  readonly workspaceId: string;
  readonly workspacePath: string;
  /** #006: загрузка контекста (правила, скилы, память). */
  loadContext(): Promise<void>;
  /** #007: восстановление последней сессии. */
  restoreSession(): Promise<void>;
  /** Пауза: ход останавливается, процесс остаётся живым. */
  pause(): Promise<void>;
  /** Мгновенное возобновление в пределах grace period. */
  resume(): Promise<void>;
  /** Shutdown процесса и освобождение ресурсов. */
  dispose(): Promise<void>;
}

/** Настройки lifecycle. */
export interface LifecycleOptions {
  readonly createRuntime: (folder: WorkspaceFolderRef) => Promise<WorkspaceRuntime>;
  /** Grace period в мс (по умолчанию 10 минут). */
  readonly graceMs?: number | undefined;
  /** Debounce смены папок, мс (по умолчанию 250). */
  readonly debounceMs?: number | undefined;
  readonly schedule?: ((callback: () => void, delayMs: number) => unknown) | undefined;
  readonly cancel?: ((handle: unknown) => void) | undefined;
  readonly onStateChanged?:
    | ((state: LifecycleState, activeWorkspaceId: string | null) => void)
    | undefined;
  readonly onActiveChanged?: ((workspaceId: string | null) => void) | undefined;
  readonly logger?: ((line: string) => void) | undefined;
}

/** Grace period по умолчанию, минуты. */
export const DEFAULT_GRACE_MINUTES = 10;

/** Debounce смены папок по умолчанию, мс. */
export const DEFAULT_DEBOUNCE_MS = 250;

/** `dsh.workspace.graceMinutes` → миллисекунды; мусор/отрицательное → 10 минут. */
export function graceMsFromMinutes(value: unknown, fallbackMinutes = DEFAULT_GRACE_MINUTES): number {
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim() !== ''
        ? Number(value)
        : Number.NaN;
  const minutes = Number.isFinite(parsed) && parsed >= 0 ? parsed : fallbackMinutes;
  return Math.round(minutes * 60_000);
}

interface RetainedRuntime {
  readonly runtime: WorkspaceRuntime;
  timer: unknown;
}

/**
 * Машина состояний воркспейса. Публичные операции сериализуются, поэтому
 * быстрая смена папок A→B→A не создаёт гонок.
 */
export class WorkspaceLifecycle {
  readonly #options: LifecycleOptions;
  readonly #graceMs: number;
  readonly #debounceMs: number;
  readonly #schedule: (callback: () => void, delayMs: number) => unknown;
  readonly #cancel: (handle: unknown) => void;
  readonly #log: (line: string) => void;

  #state: LifecycleState = 'paused';
  #active: WorkspaceRuntime | undefined;
  #retained = new Map<string, RetainedRuntime>();
  #foldersTimer: unknown;
  #chain: Promise<unknown> = Promise.resolve();
  #activating = false;
  #disposed = false;

  constructor(options: LifecycleOptions) {
    this.#options = options;
    this.#graceMs = options.graceMs ?? DEFAULT_GRACE_MINUTES * 60_000;
    this.#debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.#schedule =
      options.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.#cancel = options.cancel ?? ((handle) => clearTimeout(handle as NodeJS.Timeout));
    this.#log = options.logger ?? (() => undefined);
  }

  get state(): LifecycleState {
    return this.#state;
  }

  get activeWorkspaceId(): string | null {
    return this.#active?.workspaceId ?? null;
  }

  get activeRuntime(): WorkspaceRuntime | undefined {
    return this.#active;
  }

  /** Воркспейсы на grace period (их процессы ещё живы). */
  get retainedWorkspaceIds(): readonly string[] {
    return [...this.#retained.keys()];
  }

  /** События принимаются только от активного воркспейса. */
  acceptsEvent(workspaceId: string): boolean {
    return workspaceId === this.#active?.workspaceId;
  }

  /**
   * Debounce `onDidChangeWorkspaceFolders`: пауза текущей сессии, загрузка
   * контекста новой папки, восстановление её последней сессии. Пустой список —
   * деактивация (процесс уходит в grace period).
   */
  handleWorkspaceFolders(folders: readonly WorkspaceFolderRef[]): void {
    if (this.#disposed) {
      return;
    }
    // Пустой список при отсутствии активных/удержанных процессов — нечего
    // деактивировать: не планируем лишний таймер (старт без открытой папки).
    if (
      folders.length === 0 &&
      this.#active === undefined &&
      this.#retained.size === 0 &&
      !this.#activating &&
      this.#state !== 'resolving' &&
      this.#state !== 'loading-context'
    ) {
      return;
    }
    if (this.#foldersTimer !== undefined) {
      this.#cancel(this.#foldersTimer);
      this.#foldersTimer = undefined;
    }
    const latest = [...folders];
    this.#foldersTimer = this.#schedule(() => {
      this.#foldersTimer = undefined;
      void this.#enqueue(async () => {
        const next = latest[0];
        if (next === undefined) {
          await this.#deactivateLocked();
          return;
        }
        await this.#activateLocked(next);
      });
    }, this.#debounceMs);
  }

  /** Активирует воркспейс: reuse из grace или новый рантайм. */
  activate(folder: WorkspaceFolderRef): Promise<void> {
    return this.#enqueue(() => this.#activateLocked(folder));
  }

  /** Пауза активного воркспейса и уход в grace period / teardown. */
  deactivate(): Promise<void> {
    return this.#enqueue(() => this.#deactivateLocked());
  }

  /** Немедленный shutdown всех процессов (extension deactivate). */
  teardownAll(): Promise<void> {
    return this.#enqueue(async () => {
      const runtimes = [...this.#retained.values()].map((item) => item.runtime);
      for (const item of this.#retained.values()) {
        this.#cancel(item.timer);
      }
      this.#retained.clear();
      if (this.#active !== undefined) {
        runtimes.push(this.#active);
        this.#active = undefined;
        this.#emitActive();
      }
      for (const runtime of runtimes) {
        await this.#disposeRuntime(runtime);
      }
      this.#setState('teardown');
    });
  }

  /** Отписка и shutdown (идемпотентно). */
  async dispose(): Promise<void> {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    if (this.#foldersTimer !== undefined) {
      this.#cancel(this.#foldersTimer);
      this.#foldersTimer = undefined;
    }
    await this.teardownAll();
  }

  // --- внутреннее ----------------------------------------------------------

  async #deactivateLocked(): Promise<void> {
    if (this.#active !== undefined) {
      const runtime = this.#active;
      this.#active = undefined;
      this.#emitActive();
      await this.#retain(runtime);
    }
    if (this.#retained.size === 0) {
      this.#setState('teardown');
    }
  }

  async #activateLocked(folder: WorkspaceFolderRef): Promise<void> {
    if (this.#disposed) {
      return;
    }
    this.#activating = true;
    try {
      await this.#activateLockedInner(folder);
    } finally {
      this.#activating = false;
    }
  }

  async #activateLockedInner(folder: WorkspaceFolderRef): Promise<void> {
    if (this.#active?.workspaceId === folder.id) {
      return;
    }

    // Старая сессия — на паузу и в grace period до загрузки новой.
    if (this.#active !== undefined) {
      const previous = this.#active;
      this.#active = undefined;
      this.#emitActive();
      await this.#retain(previous);
    }

    const retained = this.#retained.get(folder.id);
    if (retained !== undefined) {
      // Быстрый возврат: процесс жив, контекст уже загружен.
      this.#cancel(retained.timer);
      this.#retained.delete(folder.id);
      try {
        await retained.runtime.resume();
      } catch (error) {
        this.#log(`Lifecycle: не удалось возобновить ${folder.id}: ${describeError(error)}`);
        await this.#disposeRuntime(retained.runtime);
        throw error;
      }
      this.#active = retained.runtime;
      this.#setState('ready');
      this.#emitActive();
      this.#log(`Lifecycle: воркспейс ${folder.id} возобновлён из grace period`);
      return;
    }

    this.#setState('resolving');
    let runtime: WorkspaceRuntime;
    try {
      runtime = await this.#options.createRuntime(folder);
    } catch (error) {
      this.#log(`Lifecycle: не удалось создать рантайм ${folder.id}: ${describeError(error)}`);
      this.#setState(this.#retained.size === 0 ? 'teardown' : 'paused');
      throw error;
    }

    try {
      this.#setState('loading-context');
      await runtime.loadContext();
      await runtime.restoreSession();
    } catch (error) {
      this.#log(`Lifecycle: не удалось загрузить контекст ${folder.id}: ${describeError(error)}`);
      await this.#disposeRuntime(runtime);
      this.#setState(this.#retained.size === 0 ? 'teardown' : 'paused');
      throw error;
    }

    this.#active = runtime;
    this.#setState('ready');
    this.#emitActive();
    this.#log(`Lifecycle: воркспейс ${folder.id} готов (${folder.path})`);
  }

  async #retain(runtime: WorkspaceRuntime): Promise<void> {
    try {
      await runtime.pause();
    } catch (error) {
      this.#log(`Lifecycle: ошибка паузы ${runtime.workspaceId}: ${describeError(error)}`);
    }
    this.#setState('paused');

    const timer = this.#schedule(() => {
      void this.#enqueue(async () => {
        const entry = this.#retained.get(runtime.workspaceId);
        if (entry === undefined) {
          return;
        }
        this.#retained.delete(runtime.workspaceId);
        await this.#disposeRuntime(runtime);
        if (this.#active === undefined && this.#retained.size === 0) {
          this.#setState('teardown');
        }
        this.#log(`Lifecycle: grace period истёк — процесс ${runtime.workspaceId} остановлен`);
      });
    }, this.#graceMs);

    this.#retained.set(runtime.workspaceId, { runtime, timer });
    this.#log(`Lifecycle: воркспейс ${runtime.workspaceId} на паузе (grace ${this.#graceMs} мс)`);
  }

  async #disposeRuntime(runtime: WorkspaceRuntime): Promise<void> {
    try {
      await runtime.dispose();
    } catch (error) {
      this.#log(`Lifecycle: ошибка shutdown ${runtime.workspaceId}: ${describeError(error)}`);
    }
  }

  #setState(state: LifecycleState): void {
    if (this.#state === state) {
      return;
    }
    this.#state = state;
    this.#options.onStateChanged?.(state, this.#active?.workspaceId ?? null);
  }

  #emitActive(): void {
    this.#options.onActiveChanged?.(this.#active?.workspaceId ?? null);
  }

  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#chain.then(operation, operation);
    this.#chain = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

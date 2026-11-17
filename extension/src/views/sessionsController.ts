/**
 * Контроллер панели Sessions (#022): связывает `SessionManager` (#007) с
 * моделью списка, обслуживает refresh/polling и действия контекстного меню.
 * Модуль без `vscode` — проверяется на мок-источнике
 * (`tests/sessions-controller.test.mjs`).
 */

import type { DshSessionSummary } from '@dsh-vscode/protocol';

import type { SessionSnapshot } from '../sessions/sessionManager';
import {
  buildSessionsView,
  SessionRefreshLoop,
  type SessionsViewState
} from './sessionsModel';

/** Источник данных — `SessionManager` (никаких HTTP напрямую из view). */
export interface SessionsSource {
  list(): Promise<readonly DshSessionSummary[]>;
  readonly state: SessionSnapshot;
  on(
    event: 'sessionChanged' | 'statusChanged',
    listener: (snapshot: SessionSnapshot) => void
  ): { dispose(): void };
  resume(sessionId: string): Promise<SessionSnapshot>;
  create(options?: { readonly title?: string }): Promise<SessionSnapshot>;
  pause(): Promise<SessionSnapshot>;
  /** Уведомление о появлении/смене менеджера (для перерисовки). */
  onSourceChanged?(listener: () => void): { dispose(): void };
  /** Необязательные действия: появятся вместе с методами рантайма. */
  rename?(sessionId: string, title: string): Promise<void>;
  remove?(sessionId: string): Promise<void>;
  openTranscript?(sessionId: string): Promise<boolean> | boolean;
}

/** Куда рисовать. */
export interface SessionsViewPort {
  render(state: SessionsViewState): void;
}

/** Настройки контроллера. */
export interface SessionsControllerOptions {
  readonly source: SessionsSource;
  readonly view: SessionsViewPort;
  readonly logger?: ((line: string) => void) | undefined;
  readonly now?: (() => Date) | undefined;
  /** Fallback-опрос (по умолчанию 5 с). */
  readonly pollIntervalMs?: number | undefined;
  readonly schedule?: ((callback: () => void, delayMs: number) => unknown) | undefined;
  readonly cancel?: ((handle: unknown) => void) | undefined;
}

/** Состояние панели Sessions. */
export class SessionsController {
  readonly #source: SessionsSource;
  readonly #view: SessionsViewPort;
  readonly #log: (line: string) => void;
  readonly #now: () => Date;
  readonly #loop: SessionRefreshLoop;
  readonly #subscriptions: { dispose(): void }[] = [];
  #sessions: readonly DshSessionSummary[] = [];
  #loading = true;
  #error: string | null = null;
  #chain: Promise<void> = Promise.resolve();
  #started = false;
  #disposed = false;

  constructor(options: SessionsControllerOptions) {
    this.#source = options.source;
    this.#view = options.view;
    this.#log = options.logger ?? (() => undefined);
    this.#now = options.now ?? (() => new Date());
    this.#loop = new SessionRefreshLoop({
      refresh: () => this.refresh(),
      intervalMs: options.pollIntervalMs ?? 5000,
      schedule: options.schedule,
      cancel: options.cancel
    });
  }

  /** Текущее состояние — для тестов и провайдера. */
  get state(): SessionsViewState {
    return this.#build();
  }

  /** Подписка на события рантайма, первая загрузка, fallback-опрос. */
  start(): void {
    if (this.#started || this.#disposed) {
      return;
    }
    this.#started = true;
    for (const event of ['sessionChanged', 'statusChanged'] as const) {
      this.#subscriptions.push(
        this.#source.on(event, () => {
          this.#loop.reset();
          void this.refresh();
        })
      );
    }
    const onSourceChanged = this.#source.onSourceChanged;
    if (onSourceChanged !== undefined) {
      this.#subscriptions.push(
        onSourceChanged.call(this.#source, () => {
          void this.refresh();
        })
      );
    }
    this.#loop.start();
    void this.refresh();
  }

  /** Остановить опрос и подписки (панель закрыта). */
  stop(): void {
    this.#started = false;
    this.#loop.stop();
    for (const subscription of this.#subscriptions.splice(0)) {
      subscription.dispose();
    }
  }

  /** Видимость панели: опрос только пока видно. */
  setVisible(visible: boolean): void {
    if (visible) {
      this.#loop.start();
      void this.refresh();
      return;
    }
    this.#loop.stop();
  }

  /** Ручной refresh (`⟳`). */
  refresh(): Promise<void> {
    if (this.#disposed) {
      return Promise.resolve();
    }
    this.#render();
    const run = async (): Promise<void> => {
      try {
        const sessions = await this.#source.list();
        this.#sessions = [...sessions];
        this.#error = null;
      } catch (error) {
        this.#error = error instanceof Error ? error.message : String(error);
        this.#log(`sessions: не удалось получить список: ${this.#error}`);
      } finally {
        this.#loading = false;
        this.#render();
      }
    };
    this.#chain = this.#chain.then(run, run);
    return this.#chain;
  }

  /** Клик по сессии — сделать активной. */
  async select(sessionId: string): Promise<void> {
    if (sessionId === this.#source.state.sessionId) {
      return;
    }
    try {
      await this.#source.resume(sessionId);
      await this.refresh();
    } catch (error) {
      this.#fail(`не удалось переключить сессию: ${describeError(error)}`);
    }
  }

  /** `+`: создание сессии (диалог #023 появится позже). */
  async create(title?: string): Promise<SessionSnapshot | null> {
    try {
      const snapshot = await this.#source.create(title === undefined ? {} : { title });
      await this.refresh();
      return snapshot;
    } catch (error) {
      this.#fail(`не удалось создать сессию: ${describeError(error)}`);
      return null;
    }
  }

  /** `Stop`: пауза активной сессии. */
  async stopSession(): Promise<void> {
    try {
      await this.#source.pause();
      await this.refresh();
    } catch (error) {
      this.#fail(`не удалось остановить сессию: ${describeError(error)}`);
    }
  }

  /** `Rename`: пока рантайм не умеет — `false` (view покажет сообщение). */
  async rename(sessionId: string, title: string): Promise<boolean> {
    if (this.#source.rename === undefined) {
      return false;
    }
    try {
      await this.#source.rename(sessionId, title);
      await this.refresh();
      return true;
    } catch (error) {
      this.#fail(`не удалось переименовать сессию: ${describeError(error)}`);
      return false;
    }
  }

  /** `Delete`: осознанное удаление (подтверждение — в view). */
  async remove(sessionId: string): Promise<boolean> {
    if (this.#source.remove === undefined) {
      return false;
    }
    try {
      await this.#source.remove(sessionId);
      await this.refresh();
      return true;
    } catch (error) {
      this.#fail(`не удалось удалить сессию: ${describeError(error)}`);
      return false;
    }
  }

  /** `Open Transcript`: `false`, если рантайм не отдаёт транскрипт. */
  async openTranscript(sessionId: string): Promise<boolean> {
    if (this.#source.openTranscript === undefined) {
      return false;
    }
    try {
      return await this.#source.openTranscript(sessionId);
    } catch (error) {
      this.#fail(`не удалось открыть транскрипт: ${describeError(error)}`);
      return false;
    }
  }

  dispose(): void {
    this.#disposed = true;
    this.stop();
  }

  #fail(message: string): void {
    this.#log(`sessions: ${message}`);
    this.#error = message;
    this.#render();
  }

  #render(): void {
    this.#view.render(this.#build());
  }

  #build(): SessionsViewState {
    return buildSessionsView({
      sessions: this.#sessions,
      snapshot: this.#source.state,
      now: this.#now(),
      loading: this.#loading,
      error: this.#error
    });
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

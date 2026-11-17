/**
 * Адаптер `SessionManager` (#007) → `SessionsSource` панели Sessions (#022).
 *
 * Менеджер появляется позже активации (#011), поэтому подписки/запросы
 * динамические: `refreshManager()` подключает слушателей к новому менеджеру,
 * а `onSourceChanged` уведомляет контроллер. Модуль без `vscode` — тесты
 * `tests/sessions-source.test.mjs`.
 */

import type { DshSessionSummary } from '@dsh-vscode/protocol';

import type { SessionManager, SessionSnapshot } from '../sessions/sessionManager';
import type { SessionsSource } from './sessionsController';

const OFFLINE_SNAPSHOT: SessionSnapshot = {
  workspaceId: '',
  sessionId: null,
  title: null,
  status: 'offline',
  turnId: null,
  updatedAt: new Date(0).toISOString()
};

/** Источник панели поверх поздно подключаемого менеджера сессий. */
export class SessionManagerSource implements SessionsSource {
  readonly #getManager: () => SessionManager | null;
  readonly #listeners = new Map<
    'sessionChanged' | 'statusChanged',
    Map<(snapshot: SessionSnapshot) => void, { dispose(): void } | null>
  >();
  readonly #sourceListeners = new Set<() => void>();
  #manager: SessionManager | null;

  constructor(getManager: () => SessionManager | null) {
    this.#getManager = getManager;
    this.#manager = getManager();
  }

  get manager(): SessionManager | null {
    return this.#manager;
  }

  /** Перечитать менеджер (после `setSessionManager`) и подключить слушателей. */
  refreshManager(): void {
    const next = this.#getManager();
    if (next === this.#manager) {
      return;
    }
    for (const [, entries] of this.#listeners) {
      for (const [listener, subscription] of entries) {
        subscription?.dispose();
        entries.set(listener, null);
      }
    }
    this.#manager = next;
    if (next !== null) {
      for (const [event, entries] of this.#listeners) {
        for (const [listener, subscription] of entries) {
          if (subscription === null) {
            entries.set(listener, next.on(event, listener));
          }
        }
      }
    }
    for (const listener of this.#sourceListeners) {
      listener();
    }
  }

  /** Подписка на смену самого менеджера (для перерисовки). */
  onSourceChanged(listener: () => void): { dispose(): void } {
    this.#sourceListeners.add(listener);
    return {
      dispose: () => {
        this.#sourceListeners.delete(listener);
      }
    };
  }

  async list(): Promise<readonly DshSessionSummary[]> {
    if (this.#manager === null) {
      throw new Error('менеджер сессий не подключён: откройте воркспейс');
    }
    return this.#manager.list();
  }

  get state(): SessionSnapshot {
    return this.#manager?.state ?? OFFLINE_SNAPSHOT;
  }

  on(
    event: 'sessionChanged' | 'statusChanged',
    listener: (snapshot: SessionSnapshot) => void
  ): { dispose(): void } {
    const entries = this.#listeners.get(event) ?? new Map();
    const existing = entries.get(listener);
    existing?.dispose();
    const subscription =
      this.#manager === null ? null : this.#manager.on(event, listener);
    entries.set(listener, subscription);
    this.#listeners.set(event, entries);
    return {
      dispose: () => {
        entries.get(listener)?.dispose();
        entries.delete(listener);
      }
    };
  }

  async resume(sessionId: string): Promise<SessionSnapshot> {
    return this.#require().resume(sessionId);
  }

  async create(options: { readonly title?: string } = {}): Promise<SessionSnapshot> {
    return this.#require().create(options);
  }

  async pause(): Promise<SessionSnapshot> {
    return this.#require().pause();
  }

  #require(): SessionManager {
    if (this.#manager === null) {
      throw new Error('менеджер сессий не подключён: откройте воркспейс');
    }
    return this.#manager;
  }
}

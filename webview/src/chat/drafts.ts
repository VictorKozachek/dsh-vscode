/**
 * Черновики composer по сессиям (#024): при переключении сессии текст не
 * теряется, у каждой сессии свой черновик. Чистый модуль — тесты
 * `tests/chat-drafts.test.mjs`.
 */
export class DraftStore {
  readonly #drafts = new Map<string, string>();

  /** Черновик сессии ('' — нет). */
  get(sessionId: string | null): string {
    return sessionId === null ? '' : (this.#drafts.get(sessionId) ?? '');
  }

  /** Сохранить черновик; пустой текст удаляет запись. */
  set(sessionId: string | null, text: string): void {
    if (sessionId === null) {
      return;
    }
    if (text === '') {
      this.#drafts.delete(sessionId);
      return;
    }
    this.#drafts.set(sessionId, text);
  }

  /** Сколько сессий имеют черновик. */
  get size(): number {
    return this.#drafts.size;
  }
}

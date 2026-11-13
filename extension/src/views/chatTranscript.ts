/**
 * История чата по сессиям (#024): сообщения хранятся отдельно для каждой
 * сессии, поэтому переключение не смешивает ленты. Модуль без зависимостей —
 * тесты `tests/chat-transcript.test.mjs`.
 */

/** Сообщение транскрипта (то, что уходит в WebView). */
export interface TranscriptMessage {
  readonly id: string;
  readonly role: 'user' | 'assistant';
  readonly text: string;
}

/** Хранилище истории по `sessionId`. */
export class SessionTranscriptStore {
  readonly #messages = new Map<string, TranscriptMessage[]>();
  #counter = 0;

  /** Добавляет сообщение пользователя. */
  appendUser(sessionId: string, text: string): TranscriptMessage {
    this.#counter += 1;
    const message: TranscriptMessage = {
      id: `user-${String(this.#counter)}`,
      role: 'user',
      text
    };
    this.#list(sessionId).push(message);
    return message;
  }

  /** Добавляет токен ответа (создаёт assistant-сообщение при первом токене). */
  appendAssistantToken(sessionId: string, text: string): void {
    if (text === '') {
      return;
    }
    const messages = this.#list(sessionId);
    const last = messages[messages.length - 1];
    if (last?.role === 'assistant') {
      messages[messages.length - 1] = { ...last, text: last.text + text };
      return;
    }
    this.#counter += 1;
    messages.push({ id: `assistant-${String(this.#counter)}`, role: 'assistant', text });
  }

  /** Копия сообщений сессии. */
  messagesFor(sessionId: string): readonly TranscriptMessage[] {
    return [...(this.#messages.get(sessionId) ?? [])];
  }

  /** Есть ли история. */
  hasHistory(sessionId: string): boolean {
    return (this.#messages.get(sessionId) ?? []).length > 0;
  }

  /** Удаляет историю (например, при удалении сессии). */
  clear(sessionId: string): void {
    this.#messages.delete(sessionId);
  }

  #list(sessionId: string): TranscriptMessage[] {
    const existing = this.#messages.get(sessionId);
    if (existing !== undefined) {
      return existing;
    }
    const created: TranscriptMessage[] = [];
    this.#messages.set(sessionId, created);
    return created;
  }
}

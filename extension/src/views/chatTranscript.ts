/**
 * История чата по сессиям (#024): сообщения и tool-записи хранятся отдельно
 * для каждой сессии, поэтому переключение не смешивает ленты.
 * Модуль без зависимостей — тесты `tests/chat-transcript.test.mjs`.
 */

/** Сообщение транскрипта (то, что уходит в WebView). */
export interface TranscriptMessage {
  readonly id: string;
  readonly role: 'user' | 'assistant';
  readonly text: string;
}

/** Запись истории: сообщение или tool-событие. */
export type TranscriptRecord =
  | { readonly kind: 'message'; readonly message: TranscriptMessage }
  | {
      readonly kind: 'toolCall';
      readonly callId: string;
      readonly name: string;
      readonly arguments: Record<string, unknown>;
    }
  | {
      readonly kind: 'toolResult';
      readonly callId: string;
      readonly ok: boolean;
      readonly result?: unknown;
      readonly error?: string;
    };

/** Хранилище истории по `sessionId`. */
export class SessionTranscriptStore {
  readonly #records = new Map<string, TranscriptRecord[]>();
  #counter = 0;

  /** Добавляет сообщение пользователя. */
  appendUser(sessionId: string, text: string): TranscriptMessage {
    this.#counter += 1;
    const message: TranscriptMessage = {
      id: `user-${String(this.#counter)}`,
      role: 'user',
      text
    };
    this.#list(sessionId).push({ kind: 'message', message });
    return message;
  }

  /** Добавляет токен ответа (создаёт assistant-сообщение при первом токене). */
  appendAssistantToken(sessionId: string, text: string): void {
    if (text === '') {
      return;
    }
    const records = this.#list(sessionId);
    const last = records[records.length - 1];
    if (last?.kind === 'message' && last.message.role === 'assistant') {
      records[records.length - 1] = {
        kind: 'message',
        message: { ...last.message, text: last.message.text + text }
      };
      return;
    }
    this.#counter += 1;
    records.push({
      kind: 'message',
      message: { id: `assistant-${String(this.#counter)}`, role: 'assistant', text }
    });
  }

  /** Запоминает вызов инструмента. */
  appendToolCall(
    sessionId: string,
    call: { readonly callId: string; readonly name: string; readonly arguments: Record<string, unknown> }
  ): void {
    this.#list(sessionId).push({
      kind: 'toolCall',
      callId: call.callId,
      name: call.name,
      arguments: { ...call.arguments }
    });
  }

  /** Запоминает результат инструмента. */
  appendToolResult(
    sessionId: string,
    result: {
      readonly callId: string;
      readonly ok: boolean;
      readonly result?: unknown;
      readonly error?: string;
    }
  ): void {
    this.#list(sessionId).push({ kind: 'toolResult', ...result });
  }

  /** Сообщения сессии (для `replaceMessages`). */
  messagesFor(sessionId: string): readonly TranscriptMessage[] {
    return this.#list(sessionId)
      .filter((record): record is { kind: 'message'; message: TranscriptMessage } => record.kind === 'message')
      .map((record) => record.message);
  }

  /** Записи сессии в порядке поступления. */
  recordsFor(sessionId: string): readonly TranscriptRecord[] {
    return [...this.#list(sessionId)];
  }

  /** Есть ли история (сообщения или tool-записи). */
  hasHistory(sessionId: string): boolean {
    return this.#list(sessionId).length > 0;
  }

  /** Удаляет историю (например, при удалении сессии). */
  clear(sessionId: string): void {
    this.#messagesDelete(sessionId);
  }

  #messagesDelete(sessionId: string): void {
    this.#records.delete(sessionId);
  }

  #list(sessionId: string): TranscriptRecord[] {
    const existing = this.#records.get(sessionId);
    if (existing !== undefined) {
      return existing;
    }
    const created: TranscriptRecord[] = [];
    this.#records.set(sessionId, created);
    return created;
  }
}

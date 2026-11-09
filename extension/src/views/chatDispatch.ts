/**
 * Диспетчер сообщений WebView → панель.
 *
 * Вынесен из `ChatViewProvider` отдельным модулем без `vscode`, чтобы
 * проверять маршрутизацию (потоковый ChatController vs эхо-режим каркаса) на
 * фейковом мосте и фейковом vscode-порте. Импорты — только типовые.
 */

import type { ChatController } from './chatEvents';
import type { ChatPanelStateDto, ExtensionMessage, WebviewMessage } from './chatHtml';

/** Минимум от `ChatSession`: обработка сообщений каркаса. */
export interface ChatDispatchSessionPort {
  handle(
    message: WebviewMessage,
    state: () => Omit<ChatPanelStateDto, 'status'>,
    emit: (message: ExtensionMessage) => void
  ): ExtensionMessage[];
}

/** Зависимости диспетчера. */
export interface ChatDispatchOptions {
  /** Потоковый чат (#008); без него — эхо-режим каркаса (#005). */
  readonly chat?: ChatController | undefined;
  readonly session: ChatDispatchSessionPort;
  readonly state: () => Omit<ChatPanelStateDto, 'status'>;
  readonly post: (message: ExtensionMessage) => Promise<void> | void;
  readonly log?: ((line: string) => void) | undefined;
}

/**
 * Обрабатывает сообщение WebView:
 * - `sendMessage` → `chat.send` (поток) или эхо; ошибка уходит в панель
 *   `chatStatus: error`, а не теряется в логе;
 * - `stop` → `chat.cancel` (turn.cancel) или статус каркаса;
 * - `ready` → состояние панели (+ текущий статус потока).
 */
export async function dispatchWebviewMessage(
  message: WebviewMessage,
  options: ChatDispatchOptions
): Promise<void> {
  const post = async (outgoing: ExtensionMessage): Promise<void> => {
    await options.post(outgoing);
  };
  const emit = (outgoing: ExtensionMessage): void => {
    void post(outgoing);
  };

  const chat = options.chat;
  if (chat !== undefined) {
    switch (message.kind) {
      case 'sendMessage': {
        try {
          await chat.send(message.text);
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          options.log?.(`панель DSH: не удалось отправить сообщение: ${detail}`);
          await post({ type: 'chatStatus', status: 'error', detail });
        }
        return;
      }
      case 'stop': {
        await chat.cancel();
        return;
      }
      case 'ready': {
        for (const outgoing of options.session.handle(message, options.state, emit)) {
          await post(outgoing);
        }
        await post({ type: 'chatStatus', status: chat.status });
        return;
      }
    }
  }

  for (const outgoing of options.session.handle(message, options.state, emit)) {
    await post(outgoing);
  }
}

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

/** Порт формы New Session (#023). */
export interface NewSessionDispatchPort {
  submit(values: {
    readonly preset: string;
    readonly model: string;
    readonly sandbox: 'read-only' | 'workspace-write' | 'danger-full-access';
    readonly approval: 'ask' | 'auto' | 'never';
    readonly title: string;
    readonly confirmDanger: boolean;
  }): void | Promise<void>;
  cancel(): void;
}

/** Порт брокера подтверждений (#009): решения из инлайн-карточки. */
export interface ApprovalDispatchPort {
  resolve(id: string, decision: 'allow' | 'allow-session' | 'deny'): boolean;
  showDiff(id: string): boolean;
}

/** Порт экрана настроек (#013). */
export interface SettingsDispatchPort {
  apply(values: Readonly<Record<string, unknown>>): Promise<void> | void;
}

/** Порт привязки чата к сессии (#024). */
export interface ChatSessionDispatchPort {
  draftChanged(text: string): void;
  openNewSession(): void;
  retryChat(): void;
}

/** Зависимости диспетчера. */
export interface ChatDispatchOptions {
  /** Потоковый чат (#008); без него — эхо-режим каркаса (#005). */
  readonly chat?: ChatController | undefined;
  readonly session: ChatDispatchSessionPort;
  readonly state: () => Omit<ChatPanelStateDto, 'status'>;
  readonly post: (message: ExtensionMessage) => Promise<void> | void;
  readonly log?: ((line: string) => void) | undefined;
  /** Форма New Session (#023). */
  readonly newSession?: NewSessionDispatchPort | undefined;
  /** Брокер подтверждений (#009); без него approval-сообщения игнорируются. */
  readonly approvals?: ApprovalDispatchPort | undefined;
  /** Привязка чата к сессии (#024). */
  readonly chatSession?: ChatSessionDispatchPort | undefined;
  /** Экран настроек dsh.* (#013). */
  readonly settings?: SettingsDispatchPort | undefined;
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

  if (message.kind === 'newSessionSubmit') {
    await options.newSession?.submit(message.values);
    return;
  }
  if (message.kind === 'newSessionCancel') {
    options.newSession?.cancel();
    return;
  }

  // Инлайн-подтверждения (#009): решение из карточки уходит в брокер.
  if (message.kind === 'approvalResolve') {
    const handled = options.approvals?.resolve(message.id, message.decision) ?? false;
    if (!handled) {
      options.log?.(`панель DSH: approval-запрос ${message.id} уже не актуален`);
    }
    return;
  }
  if (message.kind === 'approvalShowDiff') {
    options.approvals?.showDiff(message.id);
    return;
  }
  if (message.kind === 'draftChanged') {
    options.chatSession?.draftChanged(message.text);
    return;
  }
  if (message.kind === 'openNewSession') {
    options.chatSession?.openNewSession();
    return;
  }
  if (message.kind === 'retryChat') {
    options.chatSession?.retryChat();
    return;
  }
  if (message.kind === 'settingsApply') {
    await options.settings?.apply(message.values);
    return;
  }

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
        // WebView готов: отдаём начальную привязку к сессии (#024).
        chat.syncNow?.();
        return;
      }
    }
  }

  for (const outgoing of options.session.handle(message, options.state, emit)) {
    await post(outgoing);
  }
}

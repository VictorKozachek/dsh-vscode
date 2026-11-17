/**
 * `ChatViewProvider` — WebView-панель чата DSH в activity bar.
 *
 * Оболочка панели собирается здесь, содержимое — React-приложение из
 * `webview/`: `pnpm build` собирает его в `webview/dist` и копирует в
 * `extension/dist/webview`. CSP с nonce, ассеты подключаются через
 * `webview.asWebviewUri`, инлайновых скриптов нет.
 *
 * Разбор сообщений и HTML живут в `chatHtml.ts` — модуле без `vscode`, чтобы их
 * можно было покрыть тестами.
 */

import { randomBytes } from 'node:crypto';

import * as vscode from 'vscode';

import type { ChatController } from './chatEvents';
import { dispatchWebviewMessage } from './chatDispatch';
import type {
  ApprovalDispatchPort,
  ChatSessionDispatchPort,
  NewSessionDispatchPort,
  SettingsDispatchPort
} from './chatDispatch';
import {
  ChatSession,
  buildChatViewHtml,
  parseWebviewMessage,
  type ChatMessageDto,
  type ChatPanelStateDto,
  type ChatPanelStatus,
  type ExtensionMessage
} from './chatHtml';

/** Зависимости провайдера. */
export interface ChatViewProviderOptions {
  /** Корень расширения (для поиска `webview/dist`). */
  readonly extensionUri: vscode.Uri;
  /** Базовое состояние панели: воркспейс, модель, sandbox, локаль. */
  readonly state: () => Omit<ChatPanelStateDto, 'status'>;
  /** Куда писать диагностику (OutputChannel «DSH»). */
  readonly log?: ((line: string) => void) | undefined;
  /** Текст ответа-эха на сообщение пользователя (подменяется в тестах). */
  readonly echo?: ((text: string, locale: 'ru' | 'en') => string) | undefined;
  /**
   * Потоковый чат (#008): события DshBridge → WebView, батчинг токенов,
   * отмена через turn.cancel. Подключается в активации, когда есть мост;
   * без него панель работает в эхо-режиме каркаса.
   */
  readonly chat?: ChatController | undefined;
  /** Форма New Session (#023). */
  readonly newSession?: NewSessionDispatchPort | undefined;
  /** Брокер подтверждений (#009): карточки approval.* в панели. */
  readonly approvals?: ApprovalDispatchPort | undefined;
  /** Привязка чата к сессии (#024). */
  readonly chatSession?: ChatSessionDispatchPort | undefined;
  /** Экран настроек dsh.* (#013). */
  readonly settings?: SettingsDispatchPort | undefined;
}

const MAX_MESSAGES = 200;
const REPLY_DELAY_MS = 150;

/** Провайдер панели `dsh.chat`. */
export class ChatViewProvider implements vscode.WebviewViewProvider {
  /** Идентификатор view из `contributes.views` манифеста. */
  static readonly viewType = 'dsh.chat';

  readonly #options: ChatViewProviderOptions;
  readonly #session: ChatSession;
  #view: vscode.WebviewView | undefined;
  #disposed = false;
  #chat: ChatController | undefined;
  #approvals: ApprovalDispatchPort | undefined;
  #chatSession: ChatSessionDispatchPort | undefined;

  constructor(options: ChatViewProviderOptions) {
    this.#options = options;
    this.#session = new ChatSession({
      echo: options.echo,
      maxMessages: MAX_MESSAGES,
      replyDelayMs: REPLY_DELAY_MS
    });
  }

  /** Сколько сообщений сейчас в ленте (для диагностики и тестов). */
  get messageCount(): number {
    return this.#session.messages.length;
  }

  /** Текущий статус панели. */
  get status(): ChatPanelStatus {
    return this.#session.status;
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    if (this.#disposed) {
      return;
    }
    this.#view = view;

    const distUri = vscode.Uri.joinPath(this.#options.extensionUri, 'dist', 'webview');
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [distUri]
    };

    void this.#render(view.webview, distUri);
    view.onDidDispose(() => {
      if (this.#view === view) {
        this.#view = undefined;
      }
    });

    view.webview.onDidReceiveMessage((raw: unknown) => {
      void this.#handleMessage(raw);
    });
  }

  /** Отправка произвольного сообщения в панель (используется #008 и др.). */
  async postMessage(message: ExtensionMessage): Promise<void> {
    const view = this.#view;
    if (view === undefined) {
      return;
    }
    await view.webview.postMessage(message);
  }

  /** Дополнить ленту сообщением из extension host. */
  async appendMessage(message: ChatMessageDto): Promise<void> {
    for (const outgoing of this.#session.append(message)) {
      await this.postMessage(outgoing);
    }
  }

  /** Подключить потоковый чат (#011): после старта рантайма. */
  setChat(chat: ChatController | undefined): void {
    this.#chat = chat;
  }

  /** Подключить брокер подтверждений (#011). */
  setApprovals(approvals: ApprovalDispatchPort | undefined): void {
    this.#approvals = approvals;
  }

  /** Подключить привязку к сессии (#011/#024). */
  setChatSession(chatSession: ChatSessionDispatchPort | undefined): void {
    this.#chatSession = chatSession;
  }

  dispose(): void {
    this.#disposed = true;
    this.#session.dispose();
    // Панель владеет контроллером: подписки на мост снимаются вместе с ней.
    this.#options.chat?.dispose();
    this.#view = undefined;
  }

  // --- внутреннее ----------------------------------------------------------

  async #render(webview: vscode.Webview, distUri: vscode.Uri): Promise<void> {
    const nonce = randomBytes(16).toString('base64');
    const indexUri = vscode.Uri.joinPath(distUri, 'index.html');

    webview.html = await buildChatViewHtml({
      cspSource: webview.cspSource,
      nonce,
      locale: this.#options.state().locale,
      readIndexHtml: async () => {
        try {
          const content = await vscode.workspace.fs.readFile(indexUri);
          return new TextDecoder().decode(content);
        } catch (error) {
          this.#options.log?.(
            `панель DSH: webview/dist не загружен (${error instanceof Error ? error.message : String(error)})`
          );
          return null;
        }
      },
      toWebviewUri: (relative) => this.#assetUri(webview, distUri, relative)
    });
  }

  #assetUri(webview: vscode.Webview, distUri: vscode.Uri, relative: string): string {
    const clean = relative.replace(/^\.?\//, '');
    return webview.asWebviewUri(vscode.Uri.joinPath(distUri, clean)).toString();
  }

  async #handleMessage(raw: unknown): Promise<void> {
    if (this.#disposed) {
      return;
    }
    const message = parseWebviewMessage(raw);
    if (message === null) {
      this.#options.log?.('панель DSH: сообщение из WebView не по схеме');
      return;
    }

    await dispatchWebviewMessage(message, {
      chat: this.#chat,
      session: this.#session,
      state: () => this.#options.state(),
      post: (outgoing) => this.postMessage(outgoing),
      log: (line) => this.#options.log?.(line),
      newSession: this.#options.newSession,
      approvals: this.#approvals,
      chatSession: this.#chatSession,
      settings: this.#options.settings
    });
  }

}

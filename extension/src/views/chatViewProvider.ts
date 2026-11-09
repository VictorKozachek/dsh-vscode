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

import { randomBytes, randomUUID } from 'node:crypto';

import * as vscode from 'vscode';

import {
  extractViteAssets,
  parseWebviewMessage,
  renderChatViewHtml,
  renderChatViewNoticeHtml,
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
  readonly echo?: ((text: string) => string) | undefined;
}

const MAX_MESSAGES = 200;

/** Провайдер панели `dsh.chat`. */
export class ChatViewProvider implements vscode.WebviewViewProvider {
  /** Идентификатор view из `contributes.views` манифеста. */
  static readonly viewType = 'dsh.chat';

  readonly #options: ChatViewProviderOptions;
  readonly #messages: ChatMessageDto[] = [];
  #status: ChatPanelStatus = 'idle';
  #view: vscode.WebviewView | undefined;
  #disposed = false;

  constructor(options: ChatViewProviderOptions) {
    this.#options = options;
  }

  /** Сколько сообщений сейчас в ленте (для диагностики и тестов). */
  get messageCount(): number {
    return this.#messages.length;
  }

  /** Текущий статус панели. */
  get status(): ChatPanelStatus {
    return this.#status;
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
    this.#push(message);
    await this.postMessage({ type: 'message', message });
  }

  dispose(): void {
    this.#disposed = true;
    this.#view = undefined;
  }

  // --- внутреннее ----------------------------------------------------------

  async #render(webview: vscode.Webview, distUri: vscode.Uri): Promise<void> {
    const nonce = randomBytes(16).toString('base64');
    let html: string;

    try {
      const indexUri = vscode.Uri.joinPath(distUri, 'index.html');
      const content = await vscode.workspace.fs.readFile(indexUri);
      const assets = extractViteAssets(new TextDecoder().decode(content));

      if (assets.script === null) {
        throw new Error('в webview/dist/index.html не найден скрипт');
      }

      html = renderChatViewHtml({
        cspSource: webview.cspSource,
        nonce,
        scriptUri: this.#assetUri(webview, distUri, assets.script),
        styleUri: assets.style === null ? null : this.#assetUri(webview, distUri, assets.style),
        title: 'DSH'
      });
    } catch (error) {
      this.#options.log?.(
        `панель DSH: webview/dist не загружен (${error instanceof Error ? error.message : String(error)})`
      );
      html = renderChatViewNoticeHtml({
        cspSource: webview.cspSource,
        title: 'DSH',
        message: 'WebView ещё не собран — панель откроется после сборки.',
        hint: 'pnpm build'
      });
    }

    webview.html = html;
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
      this.#options.log?.(`панель DSH: сообщение из WebView не по схеме`);
      return;
    }

    switch (message.kind) {
      case 'ready': {
        await this.postMessage({ type: 'state', state: this.#state() });
        if (this.#messages.length > 0) {
          await this.postMessage({ type: 'replaceMessages', messages: [...this.#messages] });
        }
        return;
      }
      case 'stop': {
        this.#setStatus('stopped');
        await this.postMessage({ type: 'status', status: 'stopped' });
        return;
      }
      case 'sendMessage': {
        await this.#echo(message.text);
        return;
      }
    }
  }

  /**
   * Эхо-сценарий каркаса: сообщение пользователя и ответ-заглушка в ленте.
   * Настоящий обмен через DshBridge — задача #008.
   */
  async #echo(text: string): Promise<void> {
    this.#setStatus('thinking');
    await this.appendMessage({ id: randomUUID(), role: 'user', text });

    const reply = this.#options.echo?.(text) ?? `Эхо: ${text}`;
    await this.appendMessage({ id: randomUUID(), role: 'assistant', text: reply });

    this.#setStatus('idle');
    await this.postMessage({ type: 'status', status: 'idle' });
  }

  #push(message: ChatMessageDto): void {
    this.#messages.push(message);
    if (this.#messages.length > MAX_MESSAGES) {
      this.#messages.splice(0, this.#messages.length - MAX_MESSAGES);
    }
  }

  #state(): ChatPanelStateDto {
    return { ...this.#options.state(), status: this.#status };
  }

  #setStatus(status: ChatPanelStatus): void {
    this.#status = status;
  }
}

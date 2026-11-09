/**
 * Мост WebView → extension host: тонкая обёртка над `acquireVsCodeApi`,
 * чтобы компоненты не трогали `window` напрямую и легко тестировались.
 */

import type { ExtensionToWebview, WebviewToExtension } from './messages';

interface VsCodeApi {
  postMessage(message: unknown): void;
}

declare global {
  interface Window {
    acquireVsCodeApi?: () => VsCodeApi;
  }
}

let api: VsCodeApi | null = null;

function getVsCodeApi(): VsCodeApi | null {
  if (api !== null) {
    return api;
  }
  if (typeof window !== 'undefined' && typeof window.acquireVsCodeApi === 'function') {
    api = window.acquireVsCodeApi();
  }
  return api;
}

/** Отправляет сообщение в extension host (no-op вне VS Code). */
export function postToExtension(message: WebviewToExtension): void {
  getVsCodeApi()?.postMessage(message);
}

/** Подписка на сообщения из extension host; возвращает функцию отписки. */
export function onExtensionMessage(
  listener: (message: ExtensionToWebview) => void
): () => void {
  if (typeof window === 'undefined') {
    return () => undefined;
  }
  const handler = (event: MessageEvent): void => {
    listener(event.data as ExtensionToWebview);
  };
  window.addEventListener('message', handler);
  return () => {
    window.removeEventListener('message', handler);
  };
}

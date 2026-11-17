/**
 * Чистые узлы дерева Sessions (#022) — без `vscode`: провайдер только
 * превращает их в `TreeItem`. Тесты `tests/sessions-nodes.test.mjs`.
 */

import type { SessionGroup, SessionViewItem, SessionsViewState } from './sessionsModel';

/** Узел корневого уровня. */
export type SessionsNode =
  | {
      readonly kind: 'message';
      readonly label: string;
      readonly themeIcon: string;
      readonly description?: string;
      readonly tooltip?: string;
      readonly command?: { readonly command: string; readonly title: string };
    }
  | { readonly kind: 'group'; readonly group: SessionGroup }
  | { readonly kind: 'session'; readonly item: SessionViewItem };

/** Строит корневые узлы для состояния панели. */
export function buildSessionsNodes(state: SessionsViewState): readonly SessionsNode[] {
  switch (state.kind) {
    case 'loading':
      return [{ kind: 'message', label: 'Загрузка сессий…', themeIcon: 'loading~spin' }];
    case 'error':
      return [
        {
          kind: 'message',
          label: `Ошибка: ${state.error.message}`,
          themeIcon: 'error',
          description: state.error.settingsHint,
          tooltip: `${state.error.message}\n${state.error.settingsHint}`,
          ...(state.error.canRetry
            ? { command: { command: 'dsh.sessions.refresh', title: 'Повторить' } }
            : {})
        },
        // Кликабельная ссылка на настройки: viewsWelcome не виден, когда
        // дерево непустое (в нём есть узел ошибки).
        {
          kind: 'message',
          label: 'Открыть настройки DSH',
          themeIcon: 'gear',
          tooltip: 'dsh.executablePath и другие настройки DSH',
          command: { command: 'dsh.openSettings', title: 'Настройки DSH' }
        }
      ];
    case 'empty':
      return [];
    default:
      // Активная группа уже поднята наверх моделью (#022).
      return state.groups.map((group) => ({ kind: 'group', group }));
  }
}

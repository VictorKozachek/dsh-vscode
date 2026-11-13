/**
 * Панель Sessions (#022): `TreeDataProvider` поверх `SessionsController`.
 *
 * Никаких HTTP-вызовов: данные и действия идут через `SessionManager` (#007).
 * Дерево показывает группы по дате, бейджи active/idle, ошибку рантайма с
 * «Повторить» и пустое состояние (`viewsWelcome`). Клик по сессии делает её
 * активной; контекстное меню — Resume/Stop/Rename/Delete/Open Transcript.
 */

import * as vscode from 'vscode';

import type { SessionManager } from '../sessions/sessionManager';
import { SessionsController, type SessionsSource } from './sessionsController';
import type { SessionGroup, SessionViewItem, SessionsViewState } from './sessionsModel';

/** Идентификаторы панели и команд. */
export const SESSIONS_VIEW_ID = 'dsh.sessions';
export const SESSIONS_COMMANDS = {
  create: 'dsh.sessions.create',
  refresh: 'dsh.sessions.refresh',
  select: 'dsh.sessions.select',
  resume: 'dsh.sessions.resume',
  stop: 'dsh.sessions.stop',
  rename: 'dsh.sessions.rename',
  remove: 'dsh.sessions.delete',
  openTranscript: 'dsh.sessions.openTranscript'
} as const;

export interface SessionsViewOptions {
  readonly getManager: () => SessionManager | null;
  readonly log: (line: string) => void;
}

type TreeNode =
  | { readonly kind: 'group'; readonly group: SessionGroup }
  | { readonly kind: 'session'; readonly item: SessionViewItem }
  | { readonly kind: 'message'; readonly label: string; readonly themeIcon: string; readonly command?: vscode.Command };

/** Источник поверх поздно подключаемого `SessionManager`. */
function lazySource(getManager: () => SessionManager | null): SessionsSource {
  const requireManager = (): SessionManager => {
    const manager = getManager();
    if (manager === null) {
      throw new Error('менеджер сессий не подключён: откройте воркспейс');
    }
    return manager;
  };
  return {
    async list() {
      return requireManager().list();
    },
    get state() {
      const manager = getManager();
      return (
        manager?.state ?? {
          workspaceId: '',
          sessionId: null,
          title: null,
          status: 'offline' as const,
          turnId: null,
          updatedAt: new Date(0).toISOString()
        }
      );
    },
    on(event, listener) {
      const manager = getManager();
      if (manager === null) {
        return { dispose() {} };
      }
      return manager.on(event, listener);
    },
    async resume(sessionId) {
      return requireManager().resume(sessionId);
    },
    async create() {
      return requireManager().create();
    },
    async pause() {
      return requireManager().pause();
    }
  };
}

/** Провайдер дерева: рендерит состояние контроллера. */
export class SessionsTreeProvider implements vscode.TreeDataProvider<TreeNode> {
  readonly #listeners = new Set<(node?: TreeNode) => void>();
  #state: SessionsViewState = { kind: 'loading', groups: [] };

  readonly onDidChangeTreeData = (listener: (node?: TreeNode) => void): vscode.Disposable => {
    this.#listeners.add(listener);
    return {
      dispose: () => {
        this.#listeners.delete(listener);
      }
    };
  };

  /** Состояние для тестов. */
  get state(): SessionsViewState {
    return this.#state;
  }

  render(state: SessionsViewState): void {
    this.#state = state;
    for (const listener of this.#listeners) {
      listener();
    }
  }

  getChildren(element?: TreeNode): TreeNode[] {
    if (element === undefined) {
      switch (this.#state.kind) {
        case 'loading':
          return [{ kind: 'message', label: 'Загрузка сессий…', themeIcon: 'loading~spin' }];
        case 'error':
          return [
            {
              kind: 'message',
              label: `Ошибка: ${this.#state.error.message}`,
              themeIcon: 'error',
              command: {
                command: SESSIONS_COMMANDS.refresh,
                title: 'Повторить',
                arguments: []
              }
            }
          ];
        case 'empty':
          return [];
        default:
          return this.#state.groups.map((group) => ({ kind: 'group', group }));
      }
    }
    if (element.kind === 'group') {
      return element.group.items.map((item) => ({ kind: 'session', item }));
    }
    return [];
  }

  getTreeItem(node: TreeNode): vscode.TreeItem {
    if (node.kind === 'group') {
      const item = new vscode.TreeItem(node.group.label, vscode.TreeItemCollapsibleState.Expanded);
      item.contextValue = 'dshSessionGroup';
      return item;
    }
    if (node.kind === 'message') {
      const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
      item.iconPath = new vscode.ThemeIcon(node.themeIcon);
      if (node.command !== undefined) {
        item.command = node.command;
      }
      return item;
    }

    const item = new vscode.TreeItem(node.item.label, vscode.TreeItemCollapsibleState.None);
    item.id = node.item.id;
    item.description = node.item.description;
    item.tooltip = node.item.tooltip;
    item.contextValue = node.item.contextValue;
    item.iconPath = new vscode.ThemeIcon(
      node.item.badge === 'active' ? 'pass-filled' : node.item.badge === 'error' ? 'error' : 'circle-outline'
    );
    item.command = {
      command: SESSIONS_COMMANDS.select,
      title: 'Сделать активной',
      arguments: [node.item.id]
    };
    return item;
  }
}

/** Подключает панель Sessions к расширению. */
export function registerSessionsView(
  context: vscode.ExtensionContext,
  options: SessionsViewOptions
): vscode.Disposable {
  const provider = new SessionsTreeProvider();
  const treeView = vscode.window.createTreeView(SESSIONS_VIEW_ID, {
    treeDataProvider: provider,
    showCollapseAll: false
  });

  const controller = new SessionsController({
    source: lazySource(options.getManager),
    view: { render: (state) => provider.render(state) },
    logger: options.log
  });

  const notify = async (message: string): Promise<void> => {
    await vscode.window.showInformationMessage(message);
  };

  const commands: vscode.Disposable[] = [
    vscode.commands.registerCommand(SESSIONS_COMMANDS.create, async () => {
      const snapshot = await controller.create();
      if (snapshot !== null) {
        await notify(
          `DSH: создана сессия ${snapshot.sessionId ?? '?'}; диалог создания появится в #023.`
        );
      }
    }),
    vscode.commands.registerCommand(SESSIONS_COMMANDS.refresh, async () => {
      await controller.refresh();
    }),
    vscode.commands.registerCommand(SESSIONS_COMMANDS.select, async (sessionId: unknown) => {
      if (typeof sessionId === 'string' && sessionId !== '') {
        await controller.select(sessionId);
      }
    }),
    vscode.commands.registerCommand(SESSIONS_COMMANDS.resume, async (node: unknown) => {
      const sessionId = idOf(node);
      if (sessionId !== undefined) {
        await controller.select(sessionId);
      }
    }),
    vscode.commands.registerCommand(SESSIONS_COMMANDS.stop, async () => {
      await controller.stopSession();
    }),
    vscode.commands.registerCommand(SESSIONS_COMMANDS.rename, async (node: unknown) => {
      const sessionId = idOf(node);
      if (sessionId === undefined) {
        return;
      }
      const title = await vscode.window.showInputBox({
        prompt: 'Новое имя сессии',
        value: '',
        ignoreFocusOut: true
      });
      if (title === undefined || title.trim() === '') {
        return;
      }
      const ok = await controller.rename(sessionId, title.trim());
      if (!ok) {
        await notify('DSH: переименование сессии пока не поддерживается рантаймом.');
      }
    }),
    vscode.commands.registerCommand(SESSIONS_COMMANDS.remove, async (node: unknown) => {
      const sessionId = idOf(node);
      if (sessionId === undefined) {
        return;
      }
      const answer = await vscode.window.showWarningMessage(
        `Удалить сессию ${sessionId.slice(0, 8)}? Это действие нельзя отменить.`,
        { modal: true },
        'Удалить'
      );
      if (answer !== 'Удалить') {
        return;
      }
      const ok = await controller.remove(sessionId);
      if (!ok) {
        await notify('DSH: удаление сессии пока не поддерживается рантаймом.');
      }
    }),
    vscode.commands.registerCommand(SESSIONS_COMMANDS.openTranscript, async (node: unknown) => {
      const sessionId = idOf(node);
      if (sessionId === undefined) {
        return;
      }
      const ok = await controller.openTranscript(sessionId);
      if (!ok) {
        await notify('DSH: транскрипт сессии недоступен.');
      }
    })
  ];

  const updateContext = async (): Promise<void> => {
    const state = provider.state;
    await vscode.commands.executeCommand('setContext', 'dsh.sessions.empty', state.kind === 'empty');
    await vscode.commands.executeCommand('setContext', 'dsh.sessions.error', state.kind === 'error');
  };
  provider.onDidChangeTreeData(() => {
    void updateContext();
  });

  controller.start();
  // Fallback-опрос — только при открытой панели: если она скрыта, таймер не
  // крутится (и не держит extension host/тесты).
  controller.setVisible(treeView.visible === true);
  void updateContext();

  const visibility = treeView.onDidChangeVisibility?.((event: { visible: boolean }) => {
    controller.setVisible(event.visible);
  });

  return {
    dispose(): void {
      visibility?.dispose();
      controller.dispose();
      for (const command of commands) {
        command.dispose();
      }
      treeView.dispose();
      void context;
    }
  };
}

/** id сессии из аргумента команды (TreeItem-узел или строка). */
function idOf(node: unknown): string | undefined {
  if (typeof node === 'string' && node !== '') {
    return node;
  }
  if (typeof node === 'object' && node !== null) {
    const item = (node as { item?: { id?: unknown } }).item;
    if (item !== undefined && typeof item.id === 'string' && item.id !== '') {
      return item.id;
    }
  }
  return undefined;
}

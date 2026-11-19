/**
 * Kanban view (#014): read-only дерево колонок/карточек, watcher с debounce,
 * ручной refresh. Клик открывает файл карточки; запись в `.kanban` запрещена.
 */

import * as vscode from 'vscode';
import { readFile } from 'node:fs/promises';

import {
  branchBadge,
  groupKanbanCards,
  loadKanbanCards,
  type KanbanCard,
  type KanbanColumn
} from './kanban';

export const KANBAN_VIEW_ID = 'dsh.kanban';
export const KANBAN_REFRESH_COMMAND = 'dsh.kanban.refresh';
export const KANBAN_OPEN_COMMAND = 'dsh.kanban.openCard';

type Node =
  | { readonly kind: 'column'; readonly column: KanbanColumn }
  | { readonly kind: 'card'; readonly card: KanbanCard };

export class KanbanProvider implements vscode.TreeDataProvider<Node> {
  readonly #onDidChange = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.#onDidChange.event;
  #columns: readonly KanbanColumn[] = [];
  #loading = false;

  constructor(private readonly log: (line: string) => void) {}

  get columns(): readonly KanbanColumn[] {
    return this.#columns;
  }

  async refresh(): Promise<void> {
    if (this.#loading) {
      return;
    }
    this.#loading = true;
    try {
      const findFiles = (vscode.workspace as { findFiles?: unknown }).findFiles;
      if (typeof findFiles !== 'function') {
        return;
      }
      const roots = vscode.workspace.workspaceFolders ?? [];
      const files: string[] = [];
      for (const root of roots) {
        const pattern = new vscode.RelativePattern(root, '**/.kanban/tasks/*.md');
        const found = await vscode.workspace.findFiles(pattern);
        files.push(...found.map((uri) => uri.fsPath));
      }
      const cards = await loadKanbanCards(
        async () => files,
        (filePath) => readFile(filePath, 'utf8')
      );
      this.#columns = groupKanbanCards(cards);
      this.log(`kanban: загружено карточек ${String(cards.length)}`);
    } catch (error) {
      this.log(`kanban: не удалось загрузить — ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.#loading = false;
      this.#onDidChange.fire(undefined);
    }
  }

  getChildren(element?: Node): Node[] {
    if (element === undefined) {
      return this.#columns.map((column) => ({ kind: 'column', column }));
    }
    return element.kind === 'column'
      ? element.column.cards.map((card) => ({ kind: 'card', card }))
      : [];
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if (node.kind === 'column') {
      const item = new vscode.TreeItem(
        `${node.column.label} (${String(node.column.cards.length)})`,
        vscode.TreeItemCollapsibleState.Expanded
      );
      item.contextValue = 'dshKanbanColumn';
      return item;
    }
    const item = new vscode.TreeItem(
      `${node.card.id} · ${node.card.title}`,
      vscode.TreeItemCollapsibleState.None
    );
    const badge = branchBadge(node.card);
    item.description = [node.card.owner, badge].filter((part) => part !== '').join(' · ');
    item.tooltip = `${node.card.path}\nветка: ${node.card.branch || '—'}\nобновлена: ${node.card.updated}`;
    item.contextValue = 'dshKanbanCard';
    item.command = {
      command: KANBAN_OPEN_COMMAND,
      title: 'Открыть карточку',
      arguments: [node.card.path]
    };
    return item;
  }
}

/** Регистрирует view, watcher (debounce) и команды refresh/open. */
export function registerKanban(
  context: vscode.ExtensionContext,
  options: {
    readonly log: (line: string) => void;
    readonly debounceMs?: number | undefined;
    /** Уведомление webview-доски после refresh (#036). */
    readonly onColumns?: ((columns: readonly KanbanColumn[]) => void) | undefined;
  }
): KanbanProvider {
  const provider = new KanbanProvider(options.log);
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider(KANBAN_VIEW_ID, provider)
  );
  context.subscriptions.push(
    vscode.commands.registerCommand(KANBAN_REFRESH_COMMAND, () => provider.refresh()),
    vscode.commands.registerCommand(KANBAN_OPEN_COMMAND, async (filePath: unknown) => {
      if (typeof filePath !== 'string' || filePath === '') {
        return;
      }
      const openTextDocument = (vscode.workspace as { openTextDocument?: unknown }).openTextDocument;
      if (typeof openTextDocument !== 'function') {
        return;
      }
      const document = await vscode.workspace.openTextDocument(filePath);
      await vscode.window.showTextDocument(document, { preview: false });
    })
  );

  let timer: NodeJS.Timeout | undefined;
  const createWatcher = (vscode.workspace as { createFileSystemWatcher?: unknown })
    .createFileSystemWatcher;
  if (typeof createWatcher === 'function') {
    const watcher = vscode.workspace.createFileSystemWatcher('**/.kanban/tasks/*.md');
    const schedule = (): void => {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      timer = setTimeout(() => {
        timer = undefined;
        void provider.refresh();
      }, options.debounceMs ?? 300);
    };
    watcher.onDidCreate(schedule);
    watcher.onDidChange(schedule);
    watcher.onDidDelete(schedule);
    context.subscriptions.push(watcher, {
      dispose: () => {
        if (timer !== undefined) {
          clearTimeout(timer);
        }
      }
    });
  }
  void provider.refresh();
  return provider;
}

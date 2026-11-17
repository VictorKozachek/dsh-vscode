/**
 * Tree view инспектора контекста (#013). Модель — `contextInspector.ts`,
 * провайдер только рисует узлы; Reload Context пересобирает пак (#006).
 */

import * as vscode from 'vscode';

import type { ContextPack } from '../context/contextLoader';
import { buildContextInspector, contextSummary } from './contextInspector';

const VIEW_ID = 'dsh.context';

type Node =
  | { readonly kind: 'group'; readonly label: string; readonly children: readonly Node[] }
  | { readonly kind: 'leaf'; readonly label: string; readonly description?: string; readonly tooltip?: string; readonly icon?: string };

export class ContextInspectorProvider implements vscode.TreeDataProvider<Node> {
  readonly #onDidChange = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.#onDidChange.event;
  #pack: ContextPack | null = null;

  setPack(pack: ContextPack | null): void {
    this.#pack = pack;
    this.#onDidChange.fire(undefined);
  }

  refresh(): void {
    this.#onDidChange.fire(undefined);
  }

  getChildren(element?: Node): Node[] {
    if (this.#pack === null) {
      return [
        {
          kind: 'leaf',
          label: 'Контекст ещё не загружен',
          description: 'откройте воркспейс',
          icon: 'info'
        }
      ];
    }
    const inspector = buildContextInspector(this.#pack);
    if (element === undefined) {
      return [
        { kind: 'leaf', label: contextSummary(inspector), icon: 'dashboard' },
        {
          kind: 'group',
          label: `Предупреждения манифеста (${String(inspector.manifestWarnings.length)})`,
          children: inspector.manifestWarnings.map((warning) => ({
            kind: 'leaf',
            label: warning,
            icon: 'warning'
          }))
        },
        {
          kind: 'group',
          label: `Правила (${String(inspector.rules.length)})`,
          children: inspector.rules.map((rule) => ({
            kind: 'leaf',
            label: rule.path,
            description: `${rule.source}${rule.truncated ? ' · усечено' : ''}`,
            tooltip: `${rule.path}\nисточник: ${rule.source}\n${String(rule.bytes)} байт`,
            icon: 'book'
          }))
        },
        {
          kind: 'group',
          label: `Скилы (${String(inspector.skills.length)})`,
          children: inspector.skills.map((skill) => ({
            kind: 'leaf',
            label: skill.name,
            description: skill.source,
            tooltip: `${skill.path}\n${skill.description}`,
            icon: 'symbol-method'
          }))
        },
        {
          kind: 'group',
          label: `Конфликты (${String(inspector.conflicts.length)})`,
          children: inspector.conflicts.map((conflict) => ({
            kind: 'leaf',
            label: conflict.name,
            description: `${conflict.winner} > ${conflict.ignored}`,
            tooltip: conflict.explanation,
            icon: 'warning'
          }))
        },
        {
          kind: 'group',
          label: 'Проигнорированные пути',
          children: inspector.ignoredPaths.map((path) => ({
            kind: 'leaf',
            label: path,
            icon: 'circle-slash'
          }))
        }
      ];
    }
    return element.kind === 'group' ? [...element.children] : [];
  }

  getTreeItem(node: Node): vscode.TreeItem {
    const item = new vscode.TreeItem(
      node.label,
      node.kind === 'group'
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.None
    );
    if (node.kind === 'leaf') {
      if (node.description !== undefined) {
        item.description = node.description;
      }
      if (node.tooltip !== undefined) {
        item.tooltip = node.tooltip;
      }
      if (node.icon !== undefined) {
        item.iconPath = new vscode.ThemeIcon(node.icon);
      }
    }
    return item;
  }
}

/** Регистрирует view и возвращает провайдер для обновлений/фокуса. */
export function registerContextInspector(
  context: vscode.ExtensionContext,
  _options: { readonly log: (line: string) => void }
): ContextInspectorProvider {
  const provider = new ContextInspectorProvider();
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider(VIEW_ID, provider)
  );
  return provider;
}

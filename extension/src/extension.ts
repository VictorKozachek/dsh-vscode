import * as vscode from 'vscode';
import { PROTOCOL_VERSION } from '@dsh-vscode/protocol';

/**
 * Идентификаторы команд расширения. Совпадают с `contributes.commands`
 * в `extension/package.json`; список из §10 спецификации.
 */
export const COMMAND_IDS = {
  newSession: 'dsh.newSession',
  switchWorkspace: 'dsh.switchWorkspace',
  reloadContext: 'dsh.reloadContext',
  openTaskBoard: 'dsh.openTaskBoard',
  stopAgent: 'dsh.stopAgent',
  showContextInspector: 'dsh.showContextInspector',
  resumeLastSession: 'dsh.resumeLastSession',
  openSettings: 'dsh.openSettings'
} as const;

export type CommandId = (typeof COMMAND_IDS)[keyof typeof COMMAND_IDS];

const COMMAND_TITLES: Readonly<Record<CommandId, string>> = {
  [COMMAND_IDS.newSession]: 'DSH: New Session',
  [COMMAND_IDS.switchWorkspace]: 'DSH: Switch Workspace',
  [COMMAND_IDS.reloadContext]: 'DSH: Reload Context',
  [COMMAND_IDS.openTaskBoard]: 'DSH: Open Task Board',
  [COMMAND_IDS.stopAgent]: 'DSH: Stop Agent',
  [COMMAND_IDS.showContextInspector]: 'DSH: Show Context Inspector',
  [COMMAND_IDS.resumeLastSession]: 'DSH: Resume Last Session',
  [COMMAND_IDS.openSettings]: 'DSH: Open Settings'
};

let statusBarItem: vscode.StatusBarItem | undefined;

/**
 * Активация расширения: статус-бар воркспейса и команды-заглушки.
 *
 * Воркспейс здесь определяется по первой открытой папке — полноценный
 * `WorkspaceResolver` (realpath, git remote, multi-root) появится в задаче #002.
 */
export function activate(context: vscode.ExtensionContext): void {
  const log = vscode.window.createOutputChannel('DSH');
  context.subscriptions.push(log);
  log.appendLine(
    `DSH for VS Code активирован: protocol ${PROTOCOL_VERSION}, workspace ${workspaceName()}`
  );

  statusBarItem = vscode.window.createStatusBarItem(
    'dsh.status',
    vscode.StatusBarAlignment.Left,
    100
  );
  statusBarItem.name = 'DSH';
  statusBarItem.tooltip = 'DSH for VS Code';
  statusBarItem.command = COMMAND_IDS.newSession;
  context.subscriptions.push(statusBarItem);
  updateStatusBar();

  for (const command of Object.values(COMMAND_IDS)) {
    context.subscriptions.push(
      vscode.commands.registerCommand(command, () => runCommand(command))
    );
  }

  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      updateStatusBar();
      log.appendLine(`воркспейс сменился: ${workspaceName()}`);
    })
  );
}

export function deactivate(): void {
  statusBarItem?.dispose();
  statusBarItem = undefined;
}

/** Имя открытой папки (или имя workspace) для статус-бара. */
function workspaceName(): string {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (folder !== undefined) {
    return folder.name;
  }
  return vscode.workspace.name ?? 'no workspace';
}

function updateStatusBar(): void {
  if (statusBarItem === undefined) {
    return;
  }
  statusBarItem.text = `DSH · ${workspaceName()} · idle`;
  statusBarItem.show();
}

async function runCommand(command: CommandId): Promise<void> {
  if (command === COMMAND_IDS.openSettings) {
    await vscode.commands.executeCommand('workbench.action.openSettings', 'dsh');
    return;
  }
  await vscode.window.showInformationMessage(
    `${COMMAND_TITLES[command]}: заглушка каркаса, реализуется в следующих задачах.`
  );
}

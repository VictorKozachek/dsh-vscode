import * as vscode from 'vscode';
import { PROTOCOL_VERSION } from '@dsh-vscode/protocol';
import { ChatViewProvider } from './views/chatViewProvider';
import type { ChatPanelStateDto } from './views/chatHtml';
import { createSessionCommands, type SessionManager } from './sessions/sessionManager';
import { PRUNE_WORKSPACES_COMMAND, WorkspaceRegistry } from './workspace/registry';
import { registerWorkspaceLifecycle } from './workspace/lifecycleController';
import type { LifecycleState } from './workspace/lifecycle';

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
 * Менеджер сессий появляется после подключения моста DSH и воркспейса (#011).
 * До этого команды сессий честно сообщают, что мост не подключён.
 */
let sessionManager: SessionManager | null = null;

/** Подключить менеджер сессий (вызывает #011 после старта моста). */
export function setSessionManager(manager: SessionManager | null): void {
  sessionManager = manager;
}

/** Команды, которые обслуживает SessionManager (не заглушки). */
const SESSION_COMMANDS = new Set<string>([
  COMMAND_IDS.newSession,
  COMMAND_IDS.resumeLastSession,
  COMMAND_IDS.stopAgent
]);

/**
 * Активация расширения: статус-бар воркспейса и команды-заглушки.
 *
 * Воркспейс здесь определяется по первой открытой папке — полноценный
 * `WorkspaceResolver` (realpath, git remote, multi-root) появится в задаче #002.
 */
export function activate(context: vscode.ExtensionContext): void {
  outputChannel = vscode.window.createOutputChannel('DSH');
  const log = outputChannel;
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
    if (SESSION_COMMANDS.has(command)) {
      continue;
    }
    context.subscriptions.push(
      vscode.commands.registerCommand(command, () => runCommand(command))
    );
  }

  const sessionCommands = createSessionCommands({
    getManager: () => sessionManager,
    ui: {
      notify: (message) => vscode.window.showInformationMessage(message)
    }
  });
  context.subscriptions.push(
    vscode.commands.registerCommand(COMMAND_IDS.newSession, () => sessionCommands.newSession()),
    vscode.commands.registerCommand(COMMAND_IDS.resumeLastSession, () =>
      sessionCommands.resumeLast()
    ),
    vscode.commands.registerCommand(COMMAND_IDS.stopAgent, () => sessionCommands.stopAgent())
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(PRUNE_WORKSPACES_COMMAND, () => pruneWorkspaces())
  );

  // Lifecycle воркспейса (#011): смена папки переключает контекст и сессии с
  // grace period; статус-бар показывает состояние.
  context.subscriptions.push(
    registerWorkspaceLifecycle({
      context,
      log: (line) => {
        log.appendLine(line);
      },
      onStatus: (state) => updateStatusBar(state)
    })
  );

  const chatView = new ChatViewProvider({
    extensionUri: context.extensionUri,
    state: () => currentPanelState(),
    log: (line) => {
      log.appendLine(line);
    }
  });
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, chatView, {
      webviewOptions: { retainContextWhenHidden: true }
    })
  );
  context.subscriptions.push({ dispose: () => chatView.dispose() });

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

/** Состояние панели чата для только что открытого WebView. */
function currentPanelState(): Omit<ChatPanelStateDto, 'status'> {
  const configuration = vscode.workspace.getConfiguration('dsh');
  return {
    workspaceName: workspaceName(),
    model: configuration.get<string>('defaultModel') ?? 'deepseek-chat',
    sandboxMode: configuration.get<string>('sandboxMode') ?? 'workspace-write',
    locale: detectLocale()
  };
}

/** Язык интерфейса панели: ru, если интерфейс VS Code русский, иначе en. */
function detectLocale(): 'ru' | 'en' {
  const language = typeof vscode.env === 'object' && vscode.env !== undefined ? vscode.env.language : '';
  return typeof language === 'string' && language.toLowerCase().startsWith('ru') ? 'ru' : 'en';
}

/** Имя открытой папки (или имя workspace) для статус-бара. */
function workspaceName(): string {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (folder !== undefined) {
    return folder.name;
  }
  return vscode.workspace.name ?? 'no workspace';
}

/** Подпись состояния lifecycle для статус-бара. */
const LIFECYCLE_LABELS: Readonly<Record<LifecycleState, string>> = {
  resolving: 'resolving',
  'loading-context': 'loading context',
  ready: 'ready',
  paused: 'paused',
  teardown: 'idle'
};

function updateStatusBar(state?: LifecycleState): void {
  if (statusBarItem === undefined) {
    return;
  }
  const label = state === undefined ? 'idle' : LIFECYCLE_LABELS[state];
  statusBarItem.text = `DSH · ${workspaceName()} · ${label}`;
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

/**
 * `DSH: Prune Workspaces` — GC реестра воркспейсов: удаляет записи, которые
 * не открывали дольше `dsh.workspace.keepDays` дней.
 */
async function pruneWorkspaces(): Promise<void> {
  const configuration = vscode.workspace.getConfiguration('dsh');
  const registryDirectory = configuration.get<string>('workspace.registryPath');
  const keepDays = configuration.get<number>('workspace.keepDays');

  const options: { registryDir?: string; keepDays?: number } = {};
  if (typeof registryDirectory === 'string' && registryDirectory.trim() !== '') {
    options.registryDir = registryDirectory;
  }
  if (typeof keepDays === 'number' && Number.isFinite(keepDays)) {
    options.keepDays = keepDays;
  }

  try {
    const registry = new WorkspaceRegistry(options);
    const removed = await registry.prune();
    const message =
      removed.length === 0
        ? 'DSH: в реестре воркспейсов нечего чистить.'
        : `DSH: удалено записей реестра — ${String(removed.length)}.`;
    await vscode.window.showInformationMessage(message);
    if (removed.length > 0) {
      logLine(`реестр воркспейсов: удалено ${removed.join(', ')}`);
    }
  } catch (error) {
    await vscode.window.showErrorMessage(
      `DSH: не удалось почистить реестр воркспейсов: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

let outputChannel: vscode.OutputChannel | undefined;

function logLine(line: string): void {
  outputChannel?.appendLine(line);
}

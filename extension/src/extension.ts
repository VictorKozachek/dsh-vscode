import * as vscode from 'vscode';
import { PROTOCOL_VERSION } from '@dsh-vscode/protocol';
import { ChatViewProvider } from './views/chatViewProvider';
import type { ChatPanelStateDto } from './views/chatHtml';
import { createSessionCommands, type SessionManager } from './sessions/sessionManager';
import type { DiffController } from './diff/diffController';
import { PRUNE_WORKSPACES_COMMAND, WorkspaceRegistry } from './workspace/registry';
import {
  registerWorkspaceLifecycle,
  type WorkspaceLifecycleHandle
} from './workspace/lifecycleController';
import type { LifecycleState } from './workspace/lifecycle';
import { VscodeDiffEditor } from './diff/diffEditor';
import type { DshWorkspaceRuntime } from './workspace/dshRuntime';
import type { ExtensionMessage } from './views/chatHtml';
import { AcpRuntime } from './runtime/acpRuntime';
import type { RuntimeState } from './runtime/acpRuntime';

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
let workspaceLifecycle: WorkspaceLifecycleHandle | undefined;
let lastContextPack: unknown;

/**
 * DSH-рантайм воркспейса (#021). Создаётся при активации (без спавна) и
 * отдаётся #011 для проводки в lifecycle/SessionManager.
 */
let dshRuntime: AcpRuntime | undefined;

/** Экземпляр рантайма для потребителей (#011) и тестов активации. */
export function getDshRuntime(): AcpRuntime | undefined {
  return dshRuntime;
}

/**
 * Менеджер сессий появляется после подключения моста DSH и воркспейса (#011).
 * До этого команды сессий честно сообщают, что мост не подключён.
 */
let sessionManager: SessionManager | null = null;

/** Подключить менеджер сессий (вызывает #011 после старта моста). */
export function setSessionManager(manager: SessionManager | null): void {
  sessionManager = manager;
}

/** Команда отката последней правки DiffService (#010). */
export const REVERT_LAST_EDIT_COMMAND = 'dsh.revertLastEdit';

/**
 * Контроллер правок появляется вместе с воркспейсом (#011). До этого команда
 * отката честно сообщает, что откатывать нечего.
 */
let diffController: DiffController | null = null;

/** Подключить контроллер правок (вызывает #011 после выбора воркспейса). */
export function setDiffController(controller: DiffController | null): void {
  diffController = controller;
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
    vscode.commands.registerCommand(REVERT_LAST_EDIT_COMMAND, async () => {
      if (diffController === null) {
        await vscode.window.showInformationMessage(
          'DSH: Revert Last Edit — откатывать нечего (нет активного воркспейса).'
        );
        return;
      }
      await diffController.revertLastEdit();
    })
  );

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

  // Lifecycle воркспейса (#011): смена папки переключает контекст и сессии с
  // grace period; компоненты активного рантайма подключаются к панели/командам.
  const applyRuntimeHandle = (handle: { runtime: DshWorkspaceRuntime } | null): void => {
    if (handle === null) {
      chatView.setChat(undefined);
      chatView.setApprovals(undefined);
      chatView.setChatSession(undefined);
      setSessionManager(null);
      setDiffController(null);
      lastContextPack = undefined;
      void dshRuntime?.dispose();
      dshRuntime = undefined;
      return;
    }
    const runtime = handle.runtime;
    // Статус/версии #021 — от активного lifecycle-рантайма, не от глобального.
    if (dshRuntime !== runtime.acpRuntime) {
      void dshRuntime?.dispose();
      dshRuntime = runtime.acpRuntime;
    }
    updateStatusBarRuntime(runtime.acpRuntime.state);
    chatView.setChat(runtime.chat);
    chatView.setApprovals({
      resolve: (id, decision) => runtime.approvals.resolve(id, decision),
      showDiff: (id) => runtime.approvals.showDiff(id)
    });
    chatView.setChatSession({
      draftChanged: (text) => runtime.chat.setDraft(text),
      openNewSession: () => runtime.chat.requestNewSession(),
      retryChat: () => runtime.chat.retry()
    });
    setSessionManager(runtime.sessions);
    setDiffController(runtime.diff ?? null);
    lastContextPack = runtime.contextPack;
    log.appendLine(`воркспейс ${runtime.workspaceId}: рантайм подключён (${runtime.state})`);
  };

  workspaceLifecycle = registerWorkspaceLifecycle({
    context,
    log: (line) => {
      log.appendLine(line);
    },
    onStatus: (state) => updateStatusBar(state),
    onRuntimeState: (state) => updateStatusBarRuntime(state),
    postMessage: (message) => chatView.postMessage(message as ExtensionMessage),
    createDiffEditor: () => new VscodeDiffEditor(context),
    onRuntimeChange: (handle) => applyRuntimeHandle(handle)
  });
  context.subscriptions.push(workspaceLifecycle);

  const folderPath = vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath;
  if (typeof folderPath === 'string' && folderPath !== '') {
    const configuration = vscode.workspace.getConfiguration('dsh');
    dshRuntime = new AcpRuntime({
      workspacePath: folderPath,
      executablePath: configuration.get<string>('executablePath') ?? 'dsh',
      profile: configuration.get<string>('profile') ?? 'acp',
      homeDirectory: process.env['HOME'] ?? process.env['USERPROFILE'] ?? '',
      logger: (line) => {
        log.appendLine(line);
      },
      onStateChanged: (state) => {
        updateStatusBarRuntime(state);
      }
    });
  }

  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      updateStatusBar();
      log.appendLine(`воркспейс сменился: ${workspaceName()}`);
    })
  );
}

export async function deactivate(): Promise<void> {
  void dshRuntime?.dispose();
  dshRuntime = undefined;
  await workspaceLifecycle?.disposeAsync();
  workspaceLifecycle = undefined;
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

/**
 * Статус-бар из состояния DSH-рантайма (#021): после реального старта
 * показывает версии dsh/ACP (критерий «версия … в статусе»).
 */
function updateStatusBarRuntime(state: RuntimeState): void {
  if (statusBarItem === undefined) {
    return;
  }
  if (state === 'running') {
    const version = dshRuntime?.version ?? {};
    const parts = ['ready'];
    if (version.dsh !== undefined) {
      parts.push(`dsh ${version.dsh}`);
    }
    if (version.acp !== undefined) {
      parts.push(`ACP ${version.acp}`);
    }
    statusBarItem.text = `DSH · ${workspaceName()} · ${parts.join(' · ')}`;
  } else {
    statusBarItem.text = `DSH · ${workspaceName()} · ${state}`;
  }
  statusBarItem.show();
}

async function runCommand(command: CommandId): Promise<void> {
  if (command === COMMAND_IDS.showContextInspector) {
    const pack = lastContextPack as
      | {
          files?: readonly unknown[];
          skills?: readonly unknown[];
          rules?: readonly unknown[];
          stats?: { durationMs?: number };
        }
      | undefined;
    await vscode.window.showInformationMessage(
      pack === undefined
        ? 'DSH: контекст ещё не загружен (нет активного воркспейса).'
        : `DSH контекст: файлов ${pack.files?.length ?? 0}, скилов ${pack.skills?.length ?? 0}, правил ${pack.rules?.length ?? 0} (${pack.stats?.durationMs ?? 0} мс).`
    );
    return;
  }
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

import { readdir } from 'node:fs/promises';
import path from 'node:path';

import * as vscode from 'vscode';
import { PROTOCOL_VERSION } from '@dsh-vscode/protocol';
import { ChatViewProvider } from './views/chatViewProvider';
import { notifySessionsManagerChanged, registerSessionsView } from './views/sessionsView';
import type { ChatPanelStateDto } from './views/chatHtml';
import { createSessionCommands, type SessionManager } from './sessions/sessionManager';
import { NewSessionController } from './views/newSessionController';
import {
  REMEMBERED_KEY,
  type NewSessionForm,
  type NewSessionValues,
  type RememberedNewSession
} from './views/newSessionModel';
import type { DiffController } from './diff/diffController';
import { PRUNE_WORKSPACES_COMMAND, WorkspaceRegistry } from './workspace/registry';
import {
  registerWorkspaceLifecycle,
  type WorkspaceLifecycleHandle
} from './workspace/lifecycleController';
import type { LifecycleState } from './workspace/lifecycle';
import { VscodeDiffEditor } from './diff/diffEditor';
import {
  registerContextInspector,
  type ContextInspectorProvider
} from './views/contextInspectorView';
import { buildContextInspector } from './views/contextInspector';
import { registerKanban, type KanbanProvider, KANBAN_OPEN_COMMAND } from './views/kanbanView';
import { groupKanbanCards, KANBAN_COLUMNS } from './views/kanban';
import { detectKanbanPlugin } from './views/kanbanPlugin';
import type { BoardDataDto } from './views/chatHtml';
import { createVscodeTerminalSession } from './terminal/vscodeTerminal';
import { collectWorkspaceDiagnostics } from './diagnostics/vscodeDiagnostics';
import type { ContextPack } from './context/contextLoader';
import type { DshWorkspaceRuntime } from './workspace/dshRuntime';
import type { ExtensionMessage } from './views/chatHtml';
import {
  checkRemoteRuntime,
  remoteKind,
  translateWorkspacePath
} from './workspace/remote';
import { resolveWorkspace, type ResolvedWorkspace } from './workspace/resolver';
import { discoverRuntime } from './runtime/discovery';
import type { AcpRuntime, RuntimeState } from './runtime/acpRuntime';

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
  reportDiagnostics: 'dsh.reportDiagnostics',
  resumeLastSession: 'dsh.resumeLastSession',
  openSettings: 'dsh.openSettings',
  choosePrimaryWorkspace: 'dsh.choosePrimaryWorkspace',
  openBoard: 'dsh.kanban.openBoard'
} as const;

export type CommandId = (typeof COMMAND_IDS)[keyof typeof COMMAND_IDS];

const COMMAND_TITLES: Readonly<Record<CommandId, string>> = {
  [COMMAND_IDS.newSession]: 'DSH: New Session',
  [COMMAND_IDS.switchWorkspace]: 'DSH: Switch Workspace',
  [COMMAND_IDS.reloadContext]: 'DSH: Reload Context',
  [COMMAND_IDS.openTaskBoard]: 'DSH: Open Task Board',
  [COMMAND_IDS.stopAgent]: 'DSH: Stop Agent',
  [COMMAND_IDS.showContextInspector]: 'DSH: Show Context Inspector',
  [COMMAND_IDS.reportDiagnostics]: 'DSH: Report Diagnostics',
  [COMMAND_IDS.resumeLastSession]: 'DSH: Resume Last Session',
  [COMMAND_IDS.openSettings]: 'DSH: Open Settings',
  [COMMAND_IDS.choosePrimaryWorkspace]: 'DSH: Choose Primary Workspace',
  [COMMAND_IDS.openBoard]: 'DSH: Открыть Kanban-доску'
};

let statusBarItem: vscode.StatusBarItem | undefined;
let workspaceLifecycle: WorkspaceLifecycleHandle | undefined;
let lastContextPack: unknown;
let remoteWarningShown = false;
let activeWorkspace: ResolvedWorkspace | null = null;
let activeRuntime: DshWorkspaceRuntime | undefined;
let contextInspector: ContextInspectorProvider | undefined;
let chatViewProvider: ChatViewProvider | undefined;
let kanbanProvider: KanbanProvider | undefined;

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
  // Панель Sessions подписывается на события только что появившегося менеджера.
  notifySessionsManagerChanged();
}

/** Контроллер формы New Session (#023); создаётся вместе с панелью. */
let newSessionController: NewSessionController | null = null;

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
    vscode.commands.registerCommand(COMMAND_IDS.newSession, () => {
      // Без менеджера сессий форма бессмысленна: прежнее понятное сообщение.
      if (sessionManager === null || newSessionController === null) {
        return sessionCommands.newSession();
      }
      return newSessionController.open();
    }),
    vscode.commands.registerCommand(COMMAND_IDS.resumeLastSession, () =>
      sessionCommands.resumeLast()
    ),
    vscode.commands.registerCommand(COMMAND_IDS.stopAgent, () => sessionCommands.stopAgent())
  );

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
    vscode.commands.registerCommand(PRUNE_WORKSPACES_COMMAND, () => pruneWorkspaces())
  );

  const postForm = (type: 'newSessionOpen' | 'newSessionUpdate', form: NewSessionForm): void => {
    void chatView.postMessage({ type, form });
  };
  newSessionController = new NewSessionController({
    // Пресеты рантайма появятся вместе с #021; описание не задаём, чтобы
    // WebView показал локализованный fallback, а не русский текст в en-UI.
    getPresets: async () => {
      // Роли регистрируются в профиле DSH (~/.dsh/.agent-presets/<role>).
      const home = process.env['HOME'] ?? process.env['USERPROFILE'] ?? '';
      const presets: { id: string; title: string }[] = [
        { id: 'standard', title: 'standard' }
      ];
      try {
        const entries = await readdir(path.join(home, '.dsh', '.agent-presets'), {
          withFileTypes: true
        });
        for (const entry of entries) {
          if (entry.isDirectory()) {
            presets.push({ id: entry.name, title: entry.name });
          }
        }
      } catch {
        // профиль без ролей — только standard
      }
      return presets;
    },
    getModels: async () => {
      const configuration = vscode.workspace.getConfiguration('dsh');
      const configured = configuration.get<string[]>('models');
      const models = [
        configuration.get<string>('defaultModel') ?? 'deepseek-chat',
        ...(Array.isArray(configured) ? configured : [])
      ];
      return [...new Set(models.filter((model) => typeof model === 'string' && model !== ''))];
    },
    create: async (options) => {
      const manager = sessionManager;
      if (manager === null) {
        throw new Error('менеджер сессий не подключён: откройте воркспейс');
      }
      const snapshot = await manager.create({
        title: options.title,
        model: options.model,
        preset: options.preset,
        sandbox: options.sandbox,
        approval: options.approval
      });
      return { sessionId: snapshot.sessionId ?? '' };
    },
    getSettings: () => {
      const configuration = vscode.workspace.getConfiguration('dsh');
      return {
        defaultModel: configuration.get<string>('defaultModel'),
        sandboxMode: configuration.get<string>('sandboxMode'),
        approvalPolicy: configuration.get<string>('approvalPolicy')
      };
    },
    getRemembered: () =>
      context.globalState.get<RememberedNewSession>(REMEMBERED_KEY, {}) ?? {},
    remember: async (values) => {
      await context.globalState.update(REMEMBERED_KEY, values);
    },
    view: {
      open: (form) => {
        void vscode.commands.executeCommand(`${ChatViewProvider.viewType}.focus`);
        postForm('newSessionOpen', form);
      },
      update: (form) => {
        postForm('newSessionUpdate', form);
      },
      close: () => {
        void chatView.postMessage({ type: 'newSessionClose' });
      }
    },
    logger: (line) => {
      log.appendLine(line);
    },
    notifyCreated: (sessionId) => {
      void vscode.window.showInformationMessage(`DSH: сессия ${sessionId} создана.`);
    }
  });

  const chatView = new ChatViewProvider({
    extensionUri: context.extensionUri,
    state: () => currentPanelState(),
    log: (line) => {
      log.appendLine(line);
    },
    newSession: {
      submit: async (values) => {
        await newSessionController?.submit(values as NewSessionValues);
      },
      cancel: () => {
        newSessionController?.cancel();
      }
    },
    onViewDisposed: () => {
      boardVisible = false;
    },
    board: {
      refresh: async () => {
        await kanbanProvider?.refresh();
        await postKanbanBoard();
      },
      install: async () => {
        const data = lastBoardData ?? (await buildKanbanBoardData());
        await vscode.window.showInformationMessage(
          `Установите плагин: ${data.plugin.installCommand}`
        );
      },
      openCard: async (filePath: string) => {
        await vscode.commands.executeCommand(KANBAN_OPEN_COMMAND, filePath);
      },
      create: async () => {
        await vscode.window.showInformationMessage(
          'Создайте доску: bin/task-new.sh "<название>" в корне git-репозитория.'
        );
      },
      close: () => {
        boardVisible = false;
      }
    },
    settings: {
      apply: async (values) => {
        const result = await applySettings(values);
        await vscode.window.showInformationMessage(
          result.errors.length === 0
            ? `DSH: настройки применены (${String(result.applied)}).`
            : `DSH: настройки не применены — неверные значения: ${result.errors.join(', ')}.`
        );
      }
    }
  });
  chatViewProvider = chatView;
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, chatView, {
      webviewOptions: { retainContextWhenHidden: true }
    })
  );
  context.subscriptions.push({ dispose: () => chatView.dispose() });

  // Kanban-панель (#014): read-only карточки из .kanban/tasks.
  kanbanProvider = registerKanban(context, {
    log: (line) => log.appendLine(line),
    onColumns: () => {
      if (boardVisible && lastBoardData !== undefined) {
        void postKanbanBoard();
      }
    }
  });

  // Инспектор контекста (#013): реальные правила/скилы/конфликты.
  contextInspector = registerContextInspector(context, {
    log: (line) => log.appendLine(line)
  });

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
      // Ссылка на активный рантайм очищается, но сам AcpRuntime живёт в grace:
      // dispose делает lifecycle.
      dshRuntime = undefined;
      activeRuntime = undefined;
      contextInspector?.setPack(null);
      return;
    }
    const runtime = handle.runtime;
    // Статус/версии #021 — от активного lifecycle-рантайма; старый не
    // закрываем — его держит grace period lifecycle.
    dshRuntime = runtime.acpRuntime;
    activeRuntime = runtime;
    contextInspector?.setPack((runtime.contextPack ?? null) as ContextPack | null);
    updateStatusBarRuntime(runtime.acpRuntime.state);
    maybeWarnRemoteRuntime();
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
    createTerminalSession: createVscodeTerminalSession,
    collectDiagnostics: () => collectWorkspaceDiagnostics(),
    onStatus: (state) => updateStatusBar(state),
    onRuntimeState: (state) => {
      updateStatusBarRuntime(state);
      maybeWarnRemoteRuntime();
    },
    postMessage: (message) => chatView.postMessage(message as ExtensionMessage),
    createDiffEditor: () => new VscodeDiffEditor(context),
    onRuntimeChange: (handle) => applyRuntimeHandle(handle)
  });
  context.subscriptions.push(workspaceLifecycle);

  // Панель Sessions (#022): список сессий воркспейса поверх SessionManager.
  context.subscriptions.push(
    registerSessionsView(context, {
      getManager: () => sessionManager,
      log: (line) => {
        log.appendLine(line);
      }
    })
  );

  void refreshWorkspaceIdentity();
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      // До перерезолва показываем имя из новых папок, не старое.
      activeWorkspace = null;
      updateStatusBar();
      void refreshWorkspaceIdentity();
      log.appendLine(`воркспейс сменился: ${workspaceName()}`);
    })
  );
}

export async function deactivate(): Promise<void> {
  // Рантаймы закрывает lifecycle.disposeAsync (teardownAll).
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
/** Primary multi-root: настройка `dsh.primaryWorkspace`, иначе первая папка. */
export function primaryWorkspaceName(): string | undefined {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length === 0) {
    return undefined;
  }
  const configured = vscode.workspace.getConfiguration('dsh').get<string>('primaryWorkspace');
  return folders.find((folder) => folder.name === configured)?.name ?? folders[0]?.name;
}

const SETTINGS_KEYS = {
  executablePath: 'string',
  profile: 'string',
  defaultModel: 'string',
  models: 'array',
  sandboxMode: ['read-only', 'workspace-write', 'danger-full-access'],
  approvalPolicy: ['ask', 'auto', 'never'],
  'workspace.graceMinutes': 'number',
  'context.maxBytes': 'number',
  primaryWorkspace: 'string'
} as const;

/** Текущие значения dsh.* для экрана настроек (#013). */
function currentSettings(): Record<string, unknown> {
  const configuration = vscode.workspace.getConfiguration('dsh');
  return Object.fromEntries(
    Object.keys(SETTINGS_KEYS).map((key) => [key, configuration.get<unknown>(key)])
  );
}

/** Валидация и применение настроек из WebView (без рестарта). */
async function applySettings(
  values: Readonly<Record<string, unknown>>
): Promise<{ applied: number; errors: readonly string[] }> {
  const configuration = vscode.workspace.getConfiguration('dsh');
  const errors: string[] = [];
  let applied = 0;
  for (const [key, expected] of Object.entries(SETTINGS_KEYS)) {
    if (!(key in values)) {
      continue;
    }
    const value = values[key];
    const valid = Array.isArray(expected)
      ? typeof value === 'string' && expected.includes(value)
      : expected === 'array'
        ? Array.isArray(value) && value.every((item) => typeof item === 'string')
        : expected === 'number'
          ? typeof value === 'number' && Number.isFinite(value) && value >= 0
          : typeof value === 'string';
    if (!valid) {
      errors.push(key);
      continue;
    }
    await configuration.update(key, value, vscode.ConfigurationTarget.Workspace);
    applied += 1;
  }
  return { applied, errors };
}

function workspaceName(): string {
  return (
    activeWorkspace?.primary.name ??
    primaryWorkspaceName() ??
    vscode.workspace.name ??
    'no workspace'
  );
}

/**
 * Перерезолвить воркспейс: primary из настройки, WSL-пути и remote-kind
 * (#012). Используется активацией, сменой папок и командой выбора primary.
 */
async function refreshWorkspaceIdentity(): Promise<void> {
  const configuration = vscode.workspace.getConfiguration('dsh');
  const remoteName = vscode.env?.remoteName;
  const folders = (vscode.workspace.workspaceFolders ?? []).map((folder) => ({
    uri: {
      fsPath: translateWorkspacePath(folder.uri?.fsPath ?? '', {
        remoteName,
        platform: process.platform
      })
    },
    name: folder.name,
    index: folder.index
  })).filter((folder) => folder.uri.fsPath !== '');
  activeWorkspace = await resolveWorkspace(folders, {
    remoteName,
    ...(vscode.workspace.workspaceFile === undefined
      ? {}
      : { workspaceFile: vscode.workspace.workspaceFile.fsPath }),
    primaryFolder: translateWorkspacePath(
      configuration.get<string>('primaryWorkspace') ?? '',
      { remoteName, platform: process.platform }
    )
  });
  if (activeWorkspace !== null) {
    outputChannel?.appendLine(
      `воркспейс ${activeWorkspace.id}: primary ${activeWorkspace.primary.name}` +
        ` (${String(activeWorkspace.folders.length)} папок, remote ${activeWorkspace.remote})`
    );
  }
  updateStatusBar();
  await checkRemoteAvailability(remoteName);
}

/** Проверка наличия dsh на хосте: missing → инструкция, не падение. */
async function checkRemoteAvailability(remoteName: string | undefined): Promise<void> {
  const kind = remoteKind(remoteName);
  if (kind === 'local' || remoteWarningShown) {
    return;
  }
  const configuration = vscode.workspace.getConfiguration('dsh');
  const discovery = await discoverRuntime({
    homeDirectory: process.env['HOME'] ?? process.env['USERPROFILE'] ?? '',
    ...(configuration.get<string>('executablePath') === undefined
      ? {}
      : { executablePath: configuration.get<string>('executablePath') })
  });
  if (discovery.status === 'missing') {
    remoteWarningShown = true;
    await vscode.window.showWarningMessage(discovery.instructions);
  }
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

/** Remote-версия #012: missing/old → инструкция вместо падения. */
function maybeWarnRemoteRuntime(): void {
  if (remoteWarningShown || dshRuntime === undefined) {
    return;
  }
  if (remoteKind(vscode.env?.remoteName) === 'local') {
    return;
  }
  const status = checkRemoteRuntime({
    remoteName: vscode.env?.remoteName,
    version: dshRuntime.version.dsh
  });
  if (status.kind !== 'ok') {
    remoteWarningShown = true;
    void vscode.window.showWarningMessage?.(status.instructions);
  }
}

let lastBoardData: BoardDataDto | undefined;
let boardVisible = false;

async function buildKanbanBoardData(): Promise<BoardDataDto> {
  const loaded = kanbanProvider?.columns ?? [];
  const grouped = groupKanbanCards(loaded.flatMap((column) => column.cards));
  const columns = KANBAN_COLUMNS.map((status) => {
    const match = grouped.find((column) => column.status === status);
    return {
      status,
      label: match?.label ?? status,
      cards: match?.cards ?? []
    };
  });
  const profile = vscode.workspace.getConfiguration('dsh').get<string>('profile') ?? 'acp';
  const plugin = await detectKanbanPlugin({
    homeDirectory: process.env['HOME'] ?? process.env['USERPROFILE'] ?? '',
    profile
  });
  return {
    columns: columns.map((column) => ({
      status: column.status,
      label: column.label,
      cards: column.cards.map((card) => ({
        id: card.id,
        title: card.title,
        status: card.status,
        owner: card.owner,
        branch: card.branch,
        updated: card.updated,
        inBranch: card.inBranch,
        path: card.path
      }))
    })),
    plugin,
    empty: columns.every((column) => column.cards.length === 0)
  };
}

async function postKanbanBoard(): Promise<void> {
  lastBoardData = await buildKanbanBoardData();
  await chatViewProvider?.postMessage({ type: 'boardOpen', data: lastBoardData });
}

async function runCommand(command: CommandId): Promise<void> {
  if (command === COMMAND_IDS.openBoard) {
    boardVisible = true;
    // Сначала фокус/resolve webview, затем boardOpen (provider ставит в очередь
    // сообщения, пришедшие до resolve).
    await vscode.commands.executeCommand(`${ChatViewProvider.viewType}.focus`);
    await kanbanProvider?.refresh();
    await postKanbanBoard();
    return;
  }
  if (command === COMMAND_IDS.openTaskBoard) {
    await kanbanProvider?.refresh();
    try {
      await vscode.commands.executeCommand('dsh.kanban.focus');
    } catch {
      // view может быть недоступен в тестовом/скрытом окружении
    }
    return;
  }
  if (command === COMMAND_IDS.reportDiagnostics) {
    if (activeRuntime === undefined) {
      await vscode.window.showInformationMessage(
        'DSH: Report Diagnostics — нет активного воркспейса.'
      );
      return;
    }
    try {
      const report = await activeRuntime.reportDiagnostics();
      await vscode.window.showInformationMessage(
        `DSH: диагностика отправлена агенту (${String(report.total)} шт.).`
      );
    } catch (error) {
      await vscode.window.showErrorMessage(
        `DSH: не удалось отправить диагностику: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    return;
  }
  if (command === COMMAND_IDS.reloadContext) {
    if (activeRuntime === undefined) {
      await vscode.window.showInformationMessage(
        'DSH: Reload Context — нет активного воркспейса.'
      );
      return;
    }
    await activeRuntime.reloadContext();
    lastContextPack = activeRuntime.contextPack;
    contextInspector?.setPack((activeRuntime.contextPack ?? null) as ContextPack | null);
    const inspector = buildContextInspector(activeRuntime.contextPack as ContextPack);
    await vscode.window.showInformationMessage(
      `DSH: контекст перезагружен — ${String(inspector.stats.rules)} правил, ${String(inspector.stats.skills)} скилов, ${String(inspector.stats.files)} файлов.`
    );
    return;
  }
  if (command === COMMAND_IDS.showContextInspector) {
    try {
      await vscode.commands.executeCommand('dsh.context.focus');
    } catch {
      // view может быть скрыт/недоступен — сообщение ниже всё равно покажем
    }
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
  if (command === COMMAND_IDS.choosePrimaryWorkspace) {
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.length < 2) {
      await vscode.window.showInformationMessage(
        'DSH: multi-root не открыт — primary совпадает с единственной папкой.'
      );
      return;
    }
    const picked = await vscode.window.showQuickPick(
      folders.map((folder) => folder.name),
      { placeHolder: 'Primary воркспейс DSH' }
    );
    if (picked !== undefined) {
      await vscode.workspace
        .getConfiguration('dsh')
        .update('primaryWorkspace', picked, vscode.ConfigurationTarget.Workspace);
      await refreshWorkspaceIdentity();
      updateStatusBar();
    }
    return;
  }
  if (command === COMMAND_IDS.openSettings) {
    await vscode.commands.executeCommand('workbench.action.openSettings', 'dsh');
    void chatViewProvider?.postMessage({ type: 'settingsOpen', values: currentSettings() });
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
    options.registryDir = translateWorkspacePath(registryDirectory, {
      remoteName: vscode.env?.remoteName,
      platform: process.platform
    });
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

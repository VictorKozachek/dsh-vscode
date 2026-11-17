/**
 * VS Code-интеграция lifecycle воркспейса (#011).
 *
 * Слушает `onDidChangeWorkspaceFolders`, резолвит воркспейс (#002), поднимает
 * рантайм (DshBridge + SessionManager + ContextLoader), переключает сессии с
 * grace period и обновляет статус-бар. Сама машина состояний — в `lifecycle.ts`.
 */

import * as vscode from 'vscode';

import type { DshBridgeOptions } from '../bridge/dshBridge';
import type { DiffEditorPort } from '../diff/diffController';
import type { ExtensionMessage } from '../views/chatHtml';
import { WorkspaceRegistry } from './registry';
import { resolveWorkspace, type WorkspaceFolderInput } from './resolver';
import { DshWorkspaceRuntime } from './dshRuntime';
import {
  WorkspaceLifecycle,
  graceMsFromMinutes,
  type LifecycleState
} from './lifecycle';

/** Рантайм, отданный хосту для проводки чата/подтверждений/диффов. */
export interface WorkspaceRuntimeHandle {
  readonly runtime: DshWorkspaceRuntime;
}

/** Опции подключения lifecycle к расширению. */
export interface WorkspaceLifecycleHostOptions {
  readonly context: vscode.ExtensionContext;
  readonly log: (line: string) => void;
  /** Обновление статус-бара при смене состояния. */
  readonly onStatus?:
    | ((state: LifecycleState, workspaceId: string | null) => void)
    | undefined;
  /** Отдать/забрать компоненты активного воркспейса (#011). */
  readonly onRuntimeChange?: ((handle: WorkspaceRuntimeHandle | null) => void) | undefined;
  /** Сообщение в WebView (чат, approval-карточки). */
  readonly postMessage?: ((message: ExtensionMessage) => Promise<void> | void) | undefined;
  /** Фабрика diff-редактора (#010) — в проде `VscodeDiffEditor`. */
  readonly createDiffEditor?: (() => DiffEditorPort) | undefined;
  /** Подмена опций моста — интеграционные тесты. */
  readonly bridgeOptions?: Partial<DshBridgeOptions> | undefined;
}

/** Disposable lifecycle + асинхронная остановка (ждёт мост). */
export interface WorkspaceLifecycleHandle extends vscode.Disposable {
  disposeAsync(): Promise<void>;
}

/** Папки VS Code → входы резолвера (#002); неполные папки пропускаются. */
function folderInputs(): WorkspaceFolderInput[] {
  const folders = vscode.workspace.workspaceFolders ?? [];
  return folders
    .map((folder) => ({
      uri: { fsPath: folder.uri?.fsPath ?? '' },
      name: folder.name,
      index: folder.index
    }))
    .filter((folder) => folder.uri.fsPath !== '');
}

/** Настройки реестра из конфигурации. */
function registryFromConfiguration(): WorkspaceRegistry {
  const configuration = vscode.workspace.getConfiguration('dsh');
  const registryPath = configuration.get<string>('workspace.registryPath');
  const keepDays = configuration.get<number>('workspace.keepDays');
  const options: { registryDir?: string; keepDays?: number } = {};
  if (typeof registryPath === 'string' && registryPath.trim() !== '') {
    options.registryDir = registryPath;
  }
  if (typeof keepDays === 'number' && Number.isFinite(keepDays)) {
    options.keepDays = keepDays;
  }
  return new WorkspaceRegistry(options);
}

/**
 * Подключает lifecycle к расширению: активация на старте, debounce смены папок,
 * пауза старой сессии, восстановление новой, статус-бар.
 */
export function registerWorkspaceLifecycle(
  options: WorkspaceLifecycleHostOptions
): WorkspaceLifecycleHandle {
  const configuration = vscode.workspace.getConfiguration('dsh');
  const graceMs = graceMsFromMinutes(configuration.get<number>('workspace.graceMinutes'));
  const sandboxMode = configuration.get<string>('sandboxMode');
  const approvalPolicy = configuration.get<string>('approvalPolicy');
  const executablePath = configuration.get<string>('executablePath');
  const registry = registryFromConfiguration();
  const runtimes = new Map<string, DshWorkspaceRuntime>();
  let disposed = false;

  const lifecycle: WorkspaceLifecycle = new WorkspaceLifecycle({
    createRuntime: async (folder) => {
      const runtime = new DshWorkspaceRuntime({
        folder,
        memento: options.context.workspaceState as never,
        registry,
        sandboxMode,
        executablePath,
        approvalPolicy,
        log: options.log,
        post: (message) => options.postMessage?.(message),
        ...(options.createDiffEditor === undefined
          ? {}
          : { createDiffEditor: options.createDiffEditor }),
        ...(options.bridgeOptions === undefined ? {} : { bridgeOptions: options.bridgeOptions }),
        // События неактивного воркспейса отбрасываются (#011).
        isActive: () => lifecycle?.acceptsEvent(folder.id) ?? false
      });
      runtimes.set(folder.id, runtime);
      return runtime;
    },
    graceMs,
    logger: options.log,
    onStateChanged: (state, workspaceId) => {
      options.onStatus?.(state, workspaceId);
    },
    onActiveChanged: (workspaceId) => {
      options.onStatus?.(lifecycle?.state ?? 'paused', workspaceId);
      const runtime = workspaceId === null ? undefined : runtimes.get(workspaceId);
      options.onRuntimeChange?.(runtime === undefined ? null : { runtime });
    }
  });

  const refresh = async (): Promise<void> => {
    try {
      const resolved = await resolveWorkspace(folderInputs(), {
        remoteName: vscode.env?.remoteName
      });
      lifecycle?.handleWorkspaceFolders(
        resolved === null ? [] : [{ id: resolved.id, path: resolved.path }]
      );
    } catch (error) {
      // Не оставляем старый воркспейс активным при ошибке резолва: пауза.
      options.log(
        `lifecycle: не удалось определить воркспейс: ${error instanceof Error ? error.message : String(error)}`
      );
      await lifecycle?.deactivate();
      options.onStatus?.('paused', null);
      options.onRuntimeChange?.(null);
    }
  };

  const listener = vscode.workspace.onDidChangeWorkspaceFolders(() => {
    if (!disposed) {
      void refresh();
    }
  });

  // Стартовая активация: если папка уже открыта, контекст и сессия поднимутся.
  void refresh();

  return {
    dispose(): void {
      disposed = true;
      listener.dispose();
      // Синхронный Disposable VS Code: запускаем остановку, но deactivate()
      // расширения ждёт её через disposeAsync().
      void lifecycle?.dispose();
    },
    async disposeAsync(): Promise<void> {
      if (disposed) {
        return;
      }
      disposed = true;
      listener.dispose();
      await lifecycle?.dispose();
      for (const runtime of runtimes.values()) {
        await runtime.dispose();
      }
      runtimes.clear();
      options.onRuntimeChange?.(null);
    }
  };
}

/**
 * VS Code-интеграция lifecycle воркспейса (#011).
 *
 * Слушает `onDidChangeWorkspaceFolders`, резолвит воркспейс (#002), поднимает
 * рантайм (DshBridge + SessionManager + ContextLoader), переключает сессии с
 * grace period и обновляет статус-бар. Сама машина состояний — в `lifecycle.ts`.
 */

import * as vscode from 'vscode';

import { DshBridge } from '../bridge/dshBridge';
import { ContextLoader } from '../context/contextLoader';
import { SessionManager } from '../sessions/sessionManager';
import { createRegistrySessionPersistence } from '../sessions/registryPersistence';
import { WorkspaceRegistry } from './registry';
import { resolveWorkspace, type WorkspaceFolderInput } from './resolver';
import {
  WorkspaceLifecycle,
  graceMsFromMinutes,
  type LifecycleState,
  type WorkspaceFolderRef,
  type WorkspaceRuntime
} from './lifecycle';

/** Опции подключения lifecycle к расширению. */
export interface WorkspaceLifecycleHostOptions {
  readonly context: vscode.ExtensionContext;
  readonly log: (line: string) => void;
  /** Обновление статус-бара при смене состояния. */
  readonly onStatus?:
    | ((state: LifecycleState, workspaceId: string | null) => void)
    | undefined;
}

/** Рантайм одного воркспейса: мост DSH, сессии и контекст. */
class DshWorkspaceRuntime implements WorkspaceRuntime {
  readonly workspaceId: string;
  readonly workspacePath: string;
  readonly #bridge: DshBridge;
  readonly #sessions: SessionManager;
  readonly #loader: ContextLoader;
  readonly #log: (line: string) => void;

  constructor(
    folder: WorkspaceFolderRef,
    options: {
      readonly memento: vscode.Memento;
      readonly registry: WorkspaceRegistry;
      readonly sandboxMode: string | undefined;
      readonly log: (line: string) => void;
    }
  ) {
    this.workspaceId = folder.id;
    this.workspacePath = folder.path;
    this.#log = options.log;
    this.#bridge = new DshBridge({
      cwd: folder.path,
      ...(options.sandboxMode === undefined ? {} : { sandboxMode: options.sandboxMode as never }),
      logger: { appendLine: (line) => options.log(`[${folder.id}] ${line}`) }
    });
    this.#sessions = new SessionManager({
      workspaceId: folder.id,
      bridge: this.#bridge,
      storage: options.memento,
      persistence: createRegistrySessionPersistence({
        registry: options.registry,
        workspacePath: folder.path
      }),
      logger: options.log
    });
    this.#loader = new ContextLoader({ root: folder.path, logger: options.log });
  }

  async loadContext(): Promise<void> {
    const pack = await this.#loader.load();
    this.#log(`воркспейс ${this.workspaceId}: контекст загружен (${pack.stats?.durationMs ?? 0} мс)`);
  }

  async restoreSession(): Promise<void> {
    await this.#sessions.restore();
  }

  async pause(): Promise<void> {
    await this.#sessions.pause();
  }

  async resume(): Promise<void> {
    // В пределах grace процесс жив: restore возвращает активную сессию без
    // повторного запуска моста.
    await this.#sessions.restore();
  }

  async dispose(): Promise<void> {
    this.#sessions.dispose();
    this.#loader.dispose();
    await this.#bridge.stop();
  }
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
): vscode.Disposable {
  const configuration = vscode.workspace.getConfiguration('dsh');
  const graceMs = graceMsFromMinutes(configuration.get<number>('workspace.graceMinutes'));
  const sandboxMode = configuration.get<string>('sandboxMode');
  const registry = registryFromConfiguration();

  const lifecycle = new WorkspaceLifecycle({
    createRuntime: async (folder) =>
      new DshWorkspaceRuntime(folder, {
        memento: options.context.workspaceState,
        registry,
        sandboxMode,
        log: options.log
      }),
    graceMs,
    logger: options.log,
    onStateChanged: (state, workspaceId) => {
      options.onStatus?.(state, workspaceId);
    }
  });

  const refresh = async (): Promise<void> => {
    try {
      const resolved = await resolveWorkspace(folderInputs(), {
        remoteName: vscode.env?.remoteName
      });
      lifecycle.handleWorkspaceFolders(
        resolved === null ? [] : [{ id: resolved.id, path: resolved.path }]
      );
    } catch (error) {
      options.log(
        `lifecycle: не удалось определить воркспейс: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  };

  const listener = vscode.workspace.onDidChangeWorkspaceFolders(() => {
    void refresh();
  });

  // Стартовая активация: если папка уже открыта, контекст и сессия поднимутся.
  void refresh();

  // Структурный Disposable: не требуем `vscode.Disposable` в тестовом фейке.
  return {
    dispose(): void {
      listener.dispose();
      void lifecycle.dispose();
    }
  };
}

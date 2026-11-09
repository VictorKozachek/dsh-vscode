/**
 * Адаптер реестра воркспейсов (#003) к порту `SessionPersistencePort`.
 *
 * SessionManager не знает про `WorkspaceRegistry`: он работает с узким портом,
 * а этот файл связывает их в активации расширения (#011). Импорты только
 * типовые, поэтому модуль не тянет `vscode` и не мешает тестам сессий.
 */

import type { SessionPersistencePort } from './sessionManager';
import type { WorkspaceRegistry } from '../workspace/registry';

/** Настройки адаптера. */
export interface RegistrySessionPersistenceOptions {
  readonly registry: WorkspaceRegistry;
  /** Путь воркспейса — нужен, если записи в реестре ещё нет. */
  readonly workspacePath: string;
}

/** Хранит последнюю сессию воркспейса в реестре (#003). */
export function createRegistrySessionPersistence(
  options: RegistrySessionPersistenceOptions
): SessionPersistencePort {
  const { registry, workspacePath } = options;

  return {
    async readLastSession(workspaceId: string): Promise<string | null> {
      const record = await registry.read(workspaceId);
      return record?.lastSessionId ?? null;
    },

    async writeLastSession(
      workspaceId: string,
      sessionId: string | null,
      updatedAt: string
    ): Promise<void> {
      const existing = await registry.read(workspaceId);
      await registry.remember({
        ...(existing ?? {}),
        id: workspaceId,
        path: existing?.path ?? workspacePath,
        lastSessionId: sessionId,
        lastOpenedAt: updatedAt
      });
    }
  };
}

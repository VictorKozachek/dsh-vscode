/**
 * Проба пути для ApprovalBroker (#009): `lstat` + `realpath`.
 *
 * Отличает «файла нет» (можно искать существующего предка для нового файла)
 * от «компонент есть, но не резолвится» — битая symlink или ошибка доступа:
 * такие пути не разрешаются, политика отвечает fail-closed.
 */

import { lstat, realpath } from 'node:fs/promises';

import type { PathProbe } from './approvalBroker';

/** Создаёт пробу пути на node:fs (для проводки в #011). */
export function createNodePathProbe(): (absolutePath: string) => Promise<PathProbe> {
  return async (absolutePath: string): Promise<PathProbe> => {
    let stats;
    try {
      stats = await lstat(absolutePath);
    } catch (error) {
      if (isNotFound(error)) {
        return { status: 'missing' };
      }
      return {
        status: 'blocked',
        reason: error instanceof Error ? error.message : String(error)
      };
    }

    try {
      return { status: 'ok', realPath: await realpath(absolutePath) };
    } catch (error) {
      // lstat сказал «есть», realpath не смог — битая ссылка/нет доступа.
      void stats;
      return {
        status: 'blocked',
        reason: error instanceof Error ? error.message : String(error)
      };
    }
  };
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 'ENOENT'
  );
}

/** Статус плагина `dsh-kanban` в профиле рантайма (#036). Read-only. */

import { readFile } from 'node:fs/promises';
import path from 'node:path';

export interface KanbanPluginStatus {
  readonly installed: boolean;
  readonly profile: string;
  /** Точная команда установки для кнопки «Установить». */
  readonly installCommand: string;
  readonly reason?: string | undefined;
}

export interface KanbanPluginPorts {
  readonly homeDirectory: string;
  readonly profile: string;
  readonly readFile?: ((filePath: string) => Promise<string>) | undefined;
  readonly isFile?: ((filePath: string) => Promise<boolean>) | undefined;
}

/** Ищет `dsh-kanban` в package.json профиля (зависимости/плагины). */
export async function detectKanbanPlugin(ports: KanbanPluginPorts): Promise<KanbanPluginStatus> {
  const profilePath = path.join(ports.homeDirectory, '.dsh', 'profiles', ports.profile);
  const packagePath = path.join(profilePath, 'package.json');
  const installCommand = `dsh plugin --profile ${ports.profile} add @deepseek-ai/dsh-kanban`;
  const read = ports.readFile ?? ((filePath: string) => readFile(filePath, 'utf8'));
  const isFile =
    ports.isFile ??
    ((filePath: string) =>
      readFile(filePath).then(
        () => true,
        () => false
      ));
  if (!(await isFile(packagePath))) {
    return {
      installed: false,
      profile: ports.profile,
      installCommand,
      reason: `профиль ${ports.profile} не установлен`
    };
  }
  try {
    const parsed = JSON.parse(await read(packagePath)) as Record<string, unknown>;
    const names = new Set<string>();
    for (const key of ['dependencies', 'devDependencies', 'optionalDependencies']) {
      const group = parsed[key];
      if (typeof group === 'object' && group !== null) {
        for (const name of Object.keys(group)) {
          names.add(name);
        }
      }
    }
    for (const key of ['plugins', 'dshPlugins']) {
      const plugins = parsed[key];
      if (Array.isArray(plugins)) {
        for (const plugin of plugins) {
          if (typeof plugin === 'string') {
            names.add(plugin);
          } else if (typeof plugin === 'object' && plugin !== null && typeof (plugin as { name?: unknown }).name === 'string') {
            names.add((plugin as { name: string }).name);
          }
        }
      }
    }
    const installed = [...names].some((name) => name.includes('dsh-kanban'));
    return {
      installed,
      profile: ports.profile,
      installCommand,
      ...(installed ? {} : { reason: 'в профиле нет dsh-kanban' })
    };
  } catch (error) {
    return {
      installed: false,
      profile: ports.profile,
      installCommand,
      reason: `package.json не разобран: ${error instanceof Error ? error.message : String(error)}`
    };
  }
}

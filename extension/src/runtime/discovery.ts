/**
 * Поиск рантайма DSH (#021).
 *
 * Порядок: `dsh.executablePath` → `dsh` в PATH → профиль
 * `~/.dsh/profiles/<profile>/node_modules/.bin/dsh` → `npx @deepseek-ai/dsh`.
 * Модуль не зависит от `vscode`: проверки файловой системы и `which` —
 * порты, поэтому порядок и диагностика проверяются в Node
 * (`tests/runtime-discovery.test.mjs`).
 */

import path from 'node:path';

/** Откуда взят исполняемый файл. */
export type RuntimeSource = 'setting' | 'path' | 'profile' | 'npx';

/** Команда запуска ACP-профиля DSH. */
export interface RuntimeLaunchCommand {
  readonly command: string;
  readonly args: readonly string[];
  readonly source: RuntimeSource;
  /** Человекочитаемый путь для статуса. */
  readonly displayPath: string;
}

/** Результат поиска. */
export interface RuntimeDiscoveryResult {
  readonly status: 'found' | 'missing';
  readonly command?: RuntimeLaunchCommand | undefined;
  /** Понятная инструкция для экрана «рантайм не найден». */
  readonly instructions: string;
  /** Что пробовали — для лога/диагностики. */
  readonly attempts: readonly string[];
}

/** Профиль DSH, через который расширение общается с рантаймом (ACP stdio). */
export const DEFAULT_DSH_PROFILE = 'acp';

/** Инструкция по установке. */
export const RUNTIME_INSTALL_INSTRUCTIONS = [
  'DSH runtime не найден.',
  'Установите: npm i -g @deepseek-ai/dsh',
  'или укажите путь к исполняемому файлу в настройке dsh.executablePath.',
  'Профиль ACP создаётся при первом запуске: dsh --profile acp --help'
].join('\n');

/** Настройки поиска. */
export interface RuntimeDiscoveryOptions {
  /** `dsh.executablePath`; если задан и не найден — это ошибка, без fallback. */
  readonly executablePath?: string | undefined;
  /** `dsh.profile`, по умолчанию `acp`. */
  readonly profile?: string | undefined;
  readonly homeDirectory: string;
  /** Проверка, что путь существует и это файл. */
  readonly isFile?: ((filePath: string) => Promise<boolean>) | undefined;
  /** Аналог `which dsh`; `null` — не найден. */
  readonly which?: ((name: string) => Promise<string | null>) | undefined;
  /** Разрешить fallback на `npx` (по умолчанию да). */
  readonly allowNpxFallback?: boolean | undefined;
  /** Версия пакета для `npx`, если известна. */
  readonly packageVersion?: string | undefined;
}

/** Ищет рантайм по цепочке кандидатов. */
export async function discoverRuntime(
  options: RuntimeDiscoveryOptions
): Promise<RuntimeDiscoveryResult> {
  const profile = options.profile ?? DEFAULT_DSH_PROFILE;
  const attempts: string[] = [];
  const isFile =
    options.isFile ??
    (async (filePath: string): Promise<boolean> => {
      try {
        const { stat } = await import('node:fs/promises');
        return (await stat(filePath)).isFile();
      } catch {
        return false;
      }
    });
  const which =
    options.which ??
    (async (name: string): Promise<string | null> => {
      try {
        const { execFile } = await import('node:child_process');
        const { promisify } = await import('node:util');
        const { stdout } = await promisify(execFile)('which', [name]);
        return stdout.trim() === '' ? null : stdout.trim();
      } catch {
        return null;
      }
    });

  const explicit = options.executablePath?.trim();
  if (explicit !== undefined && explicit !== '') {
    // Голое имя (`dsh`, дефолт настройки) ищем через PATH; путь — как файл.
    const looksLikePath = explicit.includes('/') || explicit.includes('\\');
    if (!looksLikePath) {
      const fromSettingPath = await which(explicit);
      if (fromSettingPath !== null) {
        return found({
          command: fromSettingPath,
          args: ['--profile', profile],
          source: 'setting',
          displayPath: `${explicit} (${fromSettingPath})`
        });
      }
      attempts.push(`dsh.executablePath: ${explicit} не найден в PATH`);
      return {
        status: 'missing',
        instructions: `DSH runtime не найден по dsh.executablePath: ${explicit}.\n${RUNTIME_INSTALL_INSTRUCTIONS}`,
        attempts
      };
    }
    if (await isFile(explicit)) {
      return found({
        command: explicit,
        args: ['--profile', profile],
        source: 'setting',
        displayPath: explicit
      });
    }
    attempts.push(`dsh.executablePath: ${explicit} (не найден)`);
    // Явный путь — договор: молча уходить на другой бинарь нельзя.
    return {
      status: 'missing',
      instructions: `DSH runtime не найден по dsh.executablePath: ${explicit}.\n${RUNTIME_INSTALL_INSTRUCTIONS}`,
      attempts
    };
  }

  const fromPath = await which('dsh');
  if (fromPath !== null) {
    return found({
      command: fromPath,
      args: ['--profile', profile],
      source: 'path',
      displayPath: fromPath
    });
  }
  attempts.push('PATH: dsh не найден');

  const profileBinary = path.join(
    options.homeDirectory,
    '.dsh',
    'profiles',
    profile,
    'node_modules',
    '.bin',
    'dsh'
  );
  if (await isFile(profileBinary)) {
    return found({
      command: profileBinary,
      args: ['--profile', profile],
      source: 'profile',
      displayPath: profileBinary
    });
  }
  attempts.push(`профиль: ${profileBinary} (не найден)`);

  if (options.allowNpxFallback !== false) {
    const packageSpec =
      options.packageVersion === undefined
        ? '@deepseek-ai/dsh'
        : `@deepseek-ai/dsh@${options.packageVersion}`;
    return found({
      command: 'npx',
      args: ['--yes', packageSpec, '--profile', profile],
      source: 'npx',
      displayPath: `npx ${packageSpec}`
    });
  }

  attempts.push('npx fallback отключён');
  return { status: 'missing', instructions: RUNTIME_INSTALL_INSTRUCTIONS, attempts };
}

function found(command: RuntimeLaunchCommand): RuntimeDiscoveryResult {
  return { status: 'found', command, instructions: '', attempts: [] };
}

/** Вырезает токены/креденшелы из строки лога (URL `?token=`, `Bearer …`). */
export function redactSecrets(line: string): string {
  return line
    .replace(/([?&](?:token|access_token|api_key|key|secret)=)[^&\s]+/gi, '$1[redacted]')
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/-]+=*/g, '$1[redacted]')
    .replace(/(\/\/)[^/@\s]+@/g, '$1');
}

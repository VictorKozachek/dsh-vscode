/**
 * Remote/WSL-сценарии (#012): проверка рантайма на удалённом хосте,
 * сравнение версий и трансляция путей Windows ↔ Linux.
 *
 * Модуль без `vscode`/`child_process` — на вход приходят уже полученные
 * `remoteName`, версия и пути; проверка наличия бинаря делегируется
 * discovery (#021), а здесь остаётся чистая политика и инструкция.
 */

/** Удалённый хост VS Code. */
export type RemoteKind = 'local' | 'ssh' | 'wsl' | 'containers' | 'other';

/** Результат проверки рантайма на хосте. */
export type RemoteRuntimeStatus =
  | { readonly kind: 'ok'; readonly version: string }
  | { readonly kind: 'missing'; readonly instructions: string }
  | {
      readonly kind: 'version-mismatch';
      readonly found: string;
      readonly required: string;
      readonly instructions: string;
    };

/** Требуемая минимальная версия DSH. */
export const REQUIRED_DSH_VERSION = '0.2.0';

/** Понятная инструкция вместо падения. */
export const REMOTE_INSTRUCTIONS =
  'DSH не найден на удалённом хосте. Установите рантайм на хосте (npm i -g @deepseek-ai/dsh) ' +
  'или подключите local-воркспейс; настройка dsh.executablePath — путь к бинарю на хосте.';

/** `vscode.env.remoteName` → вид хоста. */
export function remoteKind(remoteName: string | undefined): RemoteKind {
  const value = (remoteName ?? '').trim().toLowerCase();
  if (value === '' || value === 'local') {
    return 'local';
  }
  if (value === 'ssh' || value === 'wsl' || value === 'containers') {
    return value;
  }
  return 'other';
}

/** Сравнение semver-подобных версий: -1/0/1; мусор считается ниже. */
export function compareVersions(left: string, right: string): number {
  const parse = (value: string): number[] =>
    value
      .trim()
      .replace(/^v/i, '')
      .split(/[.+-]/)
      .slice(0, 3)
      .map((part) => {
        const number = Number.parseInt(part, 10);
        return Number.isFinite(number) ? number : -1;
      });
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const leftPart = a[index] ?? 0;
    const rightPart = b[index] ?? 0;
    if (leftPart !== rightPart) {
      return leftPart < rightPart ? -1 : 1;
    }
  }
  return 0;
}

/**
 * Проверка рантайма: отсутствие бинаря и старая версия дают инструкцию,
 * а не исключение; локальный хост тоже проверяется.
 */
export function checkRemoteRuntime(options: {
  readonly remoteName?: string | undefined;
  readonly version: string | null | undefined;
  readonly required?: string | undefined;
}): RemoteRuntimeStatus {
  const required = options.required ?? REQUIRED_DSH_VERSION;
  if (options.version === null || options.version === undefined || options.version.trim() === '') {
    return { kind: 'missing', instructions: REMOTE_INSTRUCTIONS };
  }
  if (compareVersions(options.version, required) < 0) {
    return {
      kind: 'version-mismatch',
      found: options.version,
      required,
      instructions: `DSH ${options.version} старше требуемой ${required}. Обновите: npm i -g @deepseek-ai/dsh.`
    };
  }
  return { kind: 'ok', version: options.version };
}

/** Windows-путь (`C:\repo`) → WSL (`/mnt/c/repo`). */
export function windowsPathToWsl(input: string): string {
  const match = /^([A-Za-z]):[\\/](.*)$/.exec(input.trim());
  if (match === null) {
    return input.replace(/\\/g, '/');
  }
  const drive = (match[1] ?? '').toLowerCase();
  const rest = (match[2] ?? '').replace(/\\/g, '/').replace(/^\/+/, '');
  return `/mnt/${drive}/${rest}`;
}

/** WSL-путь (`/mnt/c/repo`) → Windows (`C:\repo`). */
export function wslPathToWindows(input: string): string {
  const match = /^\/mnt\/([a-z])\/(.*)$/i.exec(input.trim());
  if (match === null) {
    return input.replace(/\//g, '\\');
  }
  const drive = (match[1] ?? '').toUpperCase();
  const rest = (match[2] ?? '').replace(/\//g, '\\');
  return `${drive}:\\${rest}`;
}

/** Трансляция пути для реестра/worktree в WSL-сценарии. */
export function translateWorkspacePath(input: string, options: {
  readonly remoteName?: string | undefined;
  readonly platform?: NodeJS.Platform | undefined;
}): string {
  const kind = remoteKind(options.remoteName);
  if (kind === 'wsl') {
    return /^[A-Za-z]:[\\/]/.test(input)
      ? windowsPathToWsl(input)
      : input;
  }
  if (kind === 'local' && options.platform === 'win32' && input.startsWith('/mnt/')) {
    return wslPathToWindows(input);
  }
  return input;
}

/**
 * WorkspaceResolver — ответ на вопрос «какой это воркспейс и как его опознать
 * между запусками».
 *
 * Воркспейс = корневая папка проекта. Из неё выводятся:
 *
 * - канонический путь (`fs.realpath`, NFC, без учёта регистра в ключе на
 *   macOS/Windows);
 * - remote-хост (`ssh`/`wsl`/`containers`, по умолчанию `local`);
 * - `git remote` (нормализованный до `host/org/repo`);
 * - `id` — `sha256[:16]` от ключа воркспейса.
 *
 * Модуль не зависит от VS Code: на вход приходят папки в форме
 * `vscode.WorkspaceFolder` (`uri.fsPath`, `name`, `index`), remote передаётся
 * строкой. Так его можно покрыть unit-тестами на временных каталогах.
 *
 * На горячем пути только чтение файлов: `child_process` и вызовы `git` не
 * используются — `.git/config` разбирается напрямую.
 */

import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

/** Значение `remote`, когда папка открыта локально. */
export const LOCAL_REMOTE = 'local';

/** Сколько уровней вверх подниматься в поисках `.git` (вложенные папки). */
const GIT_DIR_MAX_DEPTH = 32;

/** Папка в форме `vscode.WorkspaceFolder` (структурный минимум). */
export interface WorkspaceFolderInput {
  readonly uri: { readonly fsPath: string };
  readonly name: string;
  readonly index: number;
}

/** Необязательные входы резолвера. */
export interface ResolveOptions {
  /** `vscode.env.remoteName`: `ssh`, `wsl`, `containers`… Локально — пусто. */
  readonly remoteName?: string | undefined;
  /** `vscode.workspace.workspaceFile`: путь к `.code-workspace`, если открыт он. */
  readonly workspaceFile?: string | undefined;
  /** Платформа для нормализации путей (по умолчанию `process.platform`). */
  readonly platform?: NodeJS.Platform | undefined;
}

/** Папка после канонизации. */
export interface ResolvedWorkspaceFolder {
  readonly path: string;
  readonly name: string;
  readonly index: number;
}

/** Результат резолва. */
export interface ResolvedWorkspace {
  /** `sha256[:16]` от ключа воркспейса. */
  readonly id: string;
  /** Канонический путь primary-папки. */
  readonly path: string;
  /** Имя primary-папки (для UI, в ключ не входит). */
  readonly name: string;
  /** Remote-хост: `local`, `ssh`, `wsl`, `containers`… */
  readonly remote: string;
  /** `host/org/repo` из `remote.origin.url` или `null`. */
  readonly gitRemote: string | null;
  /** Открыто больше одной папки. */
  readonly multiRoot: boolean;
  /** Первая папка — она же primary. */
  readonly primary: ResolvedWorkspaceFolder;
  /** Все папки воркспейса после канонизации. */
  readonly folders: readonly ResolvedWorkspaceFolder[];
  /** Путь к `.code-workspace`, если воркспейс открыт файлом. */
  readonly codeWorkspaceFile: string | null;
}

/**
 * Определяет воркспейс по открытым папкам.
 *
 * Возвращает `null`, если ни одна папка не открыта.
 *
 * `id` — хеш от remote, канонического пути и `gitRemote`; путь входит в ключ
 * всегда (§4.1): две папки одного репозитория — разные воркспейсы, переезд папки
 * создаёт новую запись реестра.
 */
export async function resolveWorkspace(
  folders: readonly WorkspaceFolderInput[],
  options: ResolveOptions = {}
): Promise<ResolvedWorkspace | null> {
  if (folders.length === 0) {
    return null;
  }

  const platform = options.platform ?? process.platform;
  const remote = normalizeRemoteName(options.remoteName);
  const resolvedFolders = await Promise.all(
    folders.map((folder) => resolveFolder(folder, platform))
  );

  const primary = resolvedFolders[0];
  if (primary === undefined) {
    return null;
  }

  const gitRemote = await readGitRemote(primary.path);
  const id = workspaceId(remote, primary.path, gitRemote, platform);
  const codeWorkspaceFile =
    options.workspaceFile === undefined
      ? null
      : await canonicalizePath(options.workspaceFile, platform);

  return {
    id,
    path: primary.path,
    name: primary.name,
    remote,
    gitRemote,
    multiRoot: resolvedFolders.length > 1,
    primary,
    folders: resolvedFolders,
    codeWorkspaceFile
  };
}

/**
 * Идентификатор воркспейса: `sha256(remote | канонический путь | gitRemote)[:16]`.
 *
 * Путь входит в ключ всегда — так две папки одного репозитория (`repo/frontend`
 * и `repo/backend`) остаются разными воркспейсами. `gitRemote` — дополнительный
 * признак проекта (для UI и реестра), а не замена пути.
 */
export function workspaceId(
  remote: string,
  canonicalPath: string,
  gitRemote: string | null,
  platform: NodeJS.Platform = process.platform
): string {
  const key = [remote, normalizePathForKey(canonicalPath, platform), gitRemote ?? ''].join('|');
  return createHash('sha256').update(key).digest('hex').slice(0, 16);
}

/**
 * Канонический путь: `realpath`, если путь существует, NFC-нормализация и
 * единые разделители. Регистр сохраняется — его меняет только ключ.
 */
export async function canonicalizePath(
  input: string,
  _platform: NodeJS.Platform = process.platform
): Promise<string> {
  const absolute = path.resolve(input);
  let resolved = absolute;
  try {
    resolved = await realpath(absolute);
  } catch {
    // Путь может не существовать (например, ещё не открытый workspace-файл):
    // тогда остаётся абсолютная форма без симлинков.
  }
  return displayPath(resolved);
}

/** Ключ пути для хеша: NFC, прямые слэши, нижний регистр на macOS/Windows. */
export function normalizePathForKey(
  input: string,
  platform: NodeJS.Platform = process.platform
): string {
  const normalized = displayPath(input).replace(/\\/g, '/').replace(/\/+$/, '');
  const result = platform === 'darwin' || platform === 'win32' ? normalized.toLowerCase() : normalized;
  return result === '' ? '/' : result;
}

/** `remoteName` из VS Code → значение ключа. */
export function normalizeRemoteName(remoteName: string | undefined): string {
  if (remoteName === undefined) {
    return LOCAL_REMOTE;
  }
  const trimmed = remoteName.trim().toLowerCase();
  return trimmed === '' ? LOCAL_REMOTE : trimmed;
}

/**
 * Нормализует URL git-remote до `host/org/repo`.
 *
 * Понимает `git@github.com:org/repo.git`, `ssh://git@host:22/org/repo.git`,
 * `https://user:token@host/org/repo.git`. Локальные пути (`/srv/repo`,
 * `file:///srv/repo`) сетевого remote не задают — возвращается `null`.
 */
export function normalizeGitRemote(url: string): string | null {
  const raw = url.trim();
  if (raw === '') {
    return null;
  }
  if (/^[a-zA-Z]:[\\/]/.test(raw) || raw.startsWith('/') || raw.startsWith('.')) {
    return null;
  }

  let host: string;
  let repoPath: string;

  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\//.exec(raw);
  if (scheme === null) {
    // scp-подобная запись: [user@]host:path
    const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(.+)$/.exec(raw);
    if (scp === null || scp[1] === undefined || scp[2] === undefined) {
      return null;
    }
    host = scp[1];
    repoPath = scp[2];
  } else {
    const protocol = (scheme[1] ?? '').toLowerCase();
    if (protocol !== 'ssh' && protocol !== 'git' && protocol !== 'http' && protocol !== 'https') {
      return null;
    }
    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      return null;
    }
    if (parsed.hostname === '') {
      return null;
    }
    host = parsed.hostname;
    repoPath = decodeURIComponent(parsed.pathname);
  }

  const normalizedHost = host.toLowerCase();
  const normalizedPath = repoPath
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .replace(/\.git$/i, '/')
    .replace(/\/+$/, '');

  if (normalizedPath === '') {
    return null;
  }
  return `${normalizedHost}/${normalizedPath}`;
}

/**
 * Достаёт `remote.origin.url` (или URL первого remote) из текста `.git/config`.
 * Возвращает исходный URL — нормализация отдельно, в `normalizeGitRemote`.
 */
export function parseGitConfigRemoteUrl(configText: string): string | null {
  let section = '';
  let originUrl: string | null = null;
  let firstUrl: string | null = null;

  for (const rawLine of configText.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#') || line.startsWith(';')) {
      continue;
    }

    const sectionMatch = /^\[\s*remote\s+"([^"]*)"\s*\]$/.exec(line);
    if (sectionMatch !== null) {
      section = sectionMatch[1] ?? '';
      continue;
    }
    if (line.startsWith('[')) {
      section = '';
      continue;
    }
    if (section === '') {
      continue;
    }

    const assignment = /^([A-Za-z][A-Za-z0-9-]*)\s*=\s*(.*)$/.exec(line);
    if (assignment === null || assignment[1] === undefined) {
      continue;
    }
    if (assignment[1].toLowerCase() !== 'url') {
      continue;
    }
    const value = unquote(assignment[2]?.trim() ?? '');
    if (value === '') {
      continue;
    }
    if (section === 'origin' && originUrl === null) {
      originUrl = value;
    }
    if (firstUrl === null) {
      firstUrl = value;
    }
  }

  return originUrl ?? firstUrl;
}

/** Читает `gitRemote` по каталогу: `host/org/repo` или `null`. */
export async function readGitRemote(directory: string): Promise<string | null> {
  const configPath = await findGitConfig(directory);
  if (configPath === null) {
    return null;
  }
  const configText = await readTextFile(configPath);
  if (configText === null) {
    return null;
  }
  const url = parseGitConfigRemoteUrl(configText);
  return url === null ? null : normalizeGitRemote(url);
}

// --- внутреннее -------------------------------------------------------------

async function resolveFolder(
  folder: WorkspaceFolderInput,
  platform: NodeJS.Platform
): Promise<ResolvedWorkspaceFolder> {
  const canonical = await canonicalizePath(folder.uri.fsPath, platform);
  const name = folder.name.trim();
  return {
    path: canonical,
    name: name === '' ? path.basename(canonical) : name,
    index: folder.index
  };
}

function displayPath(input: string): string {
  const normalized = input.normalize('NFC');
  if (normalized.length > 1) {
    return normalized.replace(/[\\/]+$/, '');
  }
  return normalized;
}

function unquote(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1);
  }
  return value;
}

async function findGitConfig(startDirectory: string): Promise<string | null> {
  let current = path.resolve(startDirectory);
  for (let depth = 0; depth <= GIT_DIR_MAX_DEPTH; depth += 1) {
    const dotGit = path.join(current, '.git');
    const kind = await statKind(dotGit);

    if (kind === 'directory') {
      return path.join(dotGit, 'config');
    }
    if (kind === 'file') {
      const gitDir = await readGitDirPointer(dotGit, current);
      if (gitDir !== null) {
        return path.join(await readCommonDir(gitDir), 'config');
      }
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
  return null;
}

async function statKind(target: string): Promise<'file' | 'directory' | null> {
  try {
    const stats = await stat(target);
    if (stats.isDirectory()) {
      return 'directory';
    }
    if (stats.isFile()) {
      return 'file';
    }
    return null;
  } catch {
    return null;
  }
}

async function readTextFile(target: string): Promise<string | null> {
  try {
    return await readFile(target, 'utf8');
  } catch {
    return null;
  }
}

/** `.git` может быть файлом (git worktree и сабмодули): `gitdir: <путь>`. */
async function readGitDirPointer(dotGitFile: string, baseDirectory: string): Promise<string | null> {
  const content = await readTextFile(dotGitFile);
  if (content === null) {
    return null;
  }
  const match = /^gitdir:\s*(.+?)\s*$/m.exec(content);
  if (match === null || match[1] === undefined) {
    return null;
  }
  return path.resolve(baseDirectory, match[1]);
}

/** У worktree общий конфиг лежит не в его gitdir, а в `commondir`. */
async function readCommonDir(gitDir: string): Promise<string> {
  const commonDirFile = path.join(gitDir, 'commondir');
  const content = await readTextFile(commonDirFile);
  if (content === null || content.trim() === '') {
    return gitDir;
  }
  return path.resolve(gitDir, content.trim());
}

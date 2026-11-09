/**
 * WorkspaceRegistry — локальный реестр воркспейсов.
 *
 * Одна запись = один JSON-файл `<registryPath>/<id>.json` со схемой из §4.2
 * [SPECIFICATION.md](../../../SPECIFICATION.md). Реестр переживает рестарты IDE
 * и не хранит секретов: ключи вида `*token*`, `*secret*`, `*password*`,
 * `*apiKey*` вырезаются, креденшелы в URL-строках вычищаются.
 *
 * Свойства записи:
 *
 * - атомарная запись: временный файл в том же каталоге + `rename`, права `0600`;
 * - версия схемы в файле и миграции `vN → vN+1` при чтении;
 * - битый JSON уходит в `<id>.json.corrupt-<ts>`, воркспейс читается как
 *   отсутствующий и создаётся заново при следующей записи;
 * - GC: `prune()` удаляет записи, не открывавшиеся `keepDays` дней.
 */

import { randomBytes } from 'node:crypto';
import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/** Текущая версия схемы записи. */
export const REGISTRY_SCHEMA_VERSION = 2;

/** Сколько дней хранить запись, которую не открывали. */
export const DEFAULT_KEEP_DAYS = 90;

/** Команда `DSH: Prune Workspaces` (contributes.commands в манифесте). */
export const PRUNE_WORKSPACES_COMMAND = 'dsh.pruneWorkspaces';

/** Значение `remote`, когда воркспейс открыт локально (как в резолвере). */
export const REGISTRY_LOCAL_REMOTE = 'local';

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_SANITIZE_DEPTH = 8;

/** `id` воркспейса: 16 hex-символов из `WorkspaceResolver`. */
const ID_PATTERN = /^[0-9a-f]{16}$/;

/** Ключи, которые не попадают в реестр (регистр не важен). */
const SECRET_KEY_PATTERN = /(token|secret|passw(or)?d|api[-_]?key|auth|credential|private[-_]?key)/i;

/** Sandbox-режим DSH (§8). */
export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';

/** Политика подтверждений (§8). */
export type ApprovalPolicy = 'ask' | 'auto' | 'never';

/** Снимок контекст-пака (§4.2). */
export interface ContextSnapshot {
  readonly hash: string;
  readonly skills: readonly string[];
  readonly rules: readonly string[];
  readonly files: number;
}

/** Запись реестра в том виде, в каком она лежит на диске. */
export interface WorkspaceRecord {
  readonly version: number;
  readonly id: string;
  readonly path: string;
  readonly remote: string;
  readonly gitRemote: string | null;
  readonly name: string;
  readonly lastOpenedAt: string;
  readonly lastSessionId: string | null;
  readonly defaultModel: string | null;
  readonly sandboxMode: SandboxMode | null;
  readonly approvalPolicy: ApprovalPolicy | null;
  readonly contextSnapshot: ContextSnapshot | null;
}

/** Что можно передать в `save`/`remember` — остальное заполняется само. */
export interface WorkspaceRecordInput {
  readonly id: string;
  readonly path: string;
  readonly remote?: string | undefined;
  readonly gitRemote?: string | null | undefined;
  readonly name?: string | undefined;
  readonly lastOpenedAt?: string | undefined;
  readonly lastSessionId?: string | null | undefined;
  readonly defaultModel?: string | null | undefined;
  readonly sandboxMode?: SandboxMode | null | undefined;
  readonly approvalPolicy?: ApprovalPolicy | null | undefined;
  readonly contextSnapshot?: ContextSnapshot | null | undefined;
}

/** Настройки реестра (соответствуют `dsh.workspace.*`). */
export interface WorkspaceRegistryOptions {
  /** Каталог реестра; `~` раскрывается. По умолчанию `~/.dsh/workspaces`. */
  readonly registryDir?: string | undefined;
  /** Срок жизни записи для `prune`, дней. */
  readonly keepDays?: number | undefined;
  /** Источник времени — подменяется в тестах. */
  readonly now?: (() => Date) | undefined;
}

/** Ошибка реестра: понятное сообщение вместо падения процесса. */
export class WorkspaceRegistryError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'WorkspaceRegistryError';
  }
}

/** Каталог реестра по умолчанию: `~/.dsh/workspaces`. */
export function defaultRegistryDirectory(homeDirectory: string = os.homedir()): string {
  return path.join(homeDirectory, '.dsh', 'workspaces');
}

/** Проверяет и возвращает `id`; защищает от выхода за пределы каталога. */
export function assertWorkspaceId(id: string): string {
  if (!ID_PATTERN.test(id)) {
    throw new WorkspaceRegistryError(
      `некорректный id воркспейса: ${JSON.stringify(id)} (ожидаются 16 hex-символов)`
    );
  }
  return id;
}

/** Вычищает креденшелы из строки: `https://user:token@host` → `https://host`. */
export function stripCredentials(value: string): string {
  return value.replace(/(\/\/)[^/@\s]+@/g, '$1');
}

export class WorkspaceRegistry {
  readonly #directory: string;
  readonly #keepDays: number;
  readonly #now: () => Date;
  #tempCounter = 0;

  constructor(options: WorkspaceRegistryOptions = {}) {
    this.#directory =
      options.registryDir === undefined
        ? defaultRegistryDirectory()
        : expandHome(options.registryDir);
    this.#keepDays = options.keepDays ?? DEFAULT_KEEP_DAYS;
    this.#now = options.now ?? (() => new Date());
  }

  /** Каталог, в котором лежит реестр. */
  get directory(): string {
    return this.#directory;
  }

  /** Путь к файлу записи. */
  filePath(id: string): string {
    return path.join(this.#directory, `${assertWorkspaceId(id)}.json`);
  }

  /**
   * Читает запись. `null` — файла нет, он битый (файл уходит в карантин) или
   * записан более новой версией схемы (файл не трогаем).
   */
  async read(id: string): Promise<WorkspaceRecord | null> {
    const file = this.filePath(id);
    let text: string;
    try {
      text = await readFile(file, 'utf8');
    } catch {
      return null;
    }

    const parsed = parseWorkspaceRecord(text, id);
    if (parsed.kind === 'record') {
      return parsed.record;
    }
    if (parsed.kind === 'future') {
      // Файл записан более новой версией расширения: не трогаем и не читаем.
      return null;
    }
    await this.#quarantine(file);
    return null;
  }

  /** Все читаемые записи, свежие сверху. */
  async list(): Promise<WorkspaceRecord[]> {
    let entries: string[];
    try {
      entries = await readdir(this.#directory);
    } catch {
      return [];
    }

    const records: WorkspaceRecord[] = [];
    for (const entry of entries) {
      if (!entry.endsWith('.json') || entry.includes('.corrupt-')) {
        continue;
      }
      const id = entry.slice(0, -'.json'.length);
      if (!ID_PATTERN.test(id)) {
        continue;
      }
      const record = await this.read(id);
      if (record !== null) {
        records.push(record);
      }
    }
    return records.sort((left, right) => right.lastOpenedAt.localeCompare(left.lastOpenedAt));
  }

  /** Атомарно записывает запись целиком. */
  async save(input: WorkspaceRecordInput): Promise<WorkspaceRecord> {
    const record = recordFromInput(input, this.#now());
    await this.#write(record);
    return record;
  }

  /** Обновляет существующую запись (или создаёт), сохраняя прошлые поля. */
  async remember(input: WorkspaceRecordInput): Promise<WorkspaceRecord> {
    const existing = await this.read(input.id);
    return this.save({ ...(existing ?? {}), ...input });
  }

  /** Отмечает воркспейс открытым сейчас. */
  async touch(id: string): Promise<WorkspaceRecord | null> {
    const existing = await this.read(id);
    if (existing === null) {
      return null;
    }
    return this.save({ ...existing, lastOpenedAt: this.#now().toISOString() });
  }

  /** Удаляет запись; `false` — её не было. */
  async remove(id: string): Promise<boolean> {
    try {
      await unlink(this.filePath(id));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * GC: удаляет записи, не открывавшиеся `keepDays` дней (и записи с
   * нечитаемой датой). Возвращает удалённые `id`.
   */
  async prune(keepDays: number = this.#keepDays): Promise<string[]> {
    if (!Number.isFinite(keepDays) || keepDays < 0) {
      throw new WorkspaceRegistryError(
        `некорректный срок хранения записей: ${String(keepDays)} (ожидается число дней ≥ 0)`
      );
    }
    const cutoff = this.#now().getTime() - keepDays * DAY_MS;

    const removed: string[] = [];
    for (const record of await this.list()) {
      const openedAt = Date.parse(record.lastOpenedAt);
      if (Number.isNaN(openedAt) || openedAt < cutoff) {
        if (await this.remove(record.id)) {
          removed.push(record.id);
        }
      }
    }
    return removed.sort();
  }

  async #write(record: WorkspaceRecord): Promise<void> {
    const target = this.filePath(record.id);
    const temp = path.join(
      this.#directory,
      `.${record.id}.json.tmp-${process.pid}-${String(this.#tempCounter)}-${randomBytes(4).toString('hex')}`
    );

    try {
      await mkdir(this.#directory, { recursive: true, mode: 0o700 });
      await writeFile(temp, `${JSON.stringify(record, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      await rename(temp, target);
    } catch (error) {
      await unlink(temp).catch(() => undefined);
      throw new WorkspaceRegistryError(
        `не удалось записать запись реестра ${record.id} в ${this.#directory}: ${errorMessage(error)}`,
        { cause: error }
      );
    }
  }

  /** Битый файл не затираем молча: уводим в `<id>.json.corrupt-<ts>`. */
  async #quarantine(file: string): Promise<void> {
    const timestamp = this.#now().getTime();
    let target = `${file}.corrupt-${String(timestamp)}`;
    for (let attempt = 1; ; attempt += 1) {
      try {
        await rename(file, target);
        return;
      } catch (error) {
        if (!isAlreadyExistsError(error)) {
          return;
        }
        target = `${file}.corrupt-${String(timestamp)}-${String(attempt)}`;
      }
    }
  }
}

// --- разбор и миграции -------------------------------------------------------

type ParseResult =
  | { readonly kind: 'record'; readonly record: WorkspaceRecord }
  | { readonly kind: 'corrupt' }
  | { readonly kind: 'future' };

type RawObject = Record<string, unknown>;

type Migration = (raw: RawObject) => RawObject;

/**
 * Миграции `vN → vN+1`. v1 — ранний формат: `lastOpenedAt` в миллисекундах,
 * без `remote`/`gitRemote`/`contextSnapshot`.
 */
const MIGRATIONS: Readonly<Record<number, Migration>> = {
  1: (raw) => ({
    ...raw,
    version: 2,
    remote: typeof raw['remote'] === 'string' ? raw['remote'] : REGISTRY_LOCAL_REMOTE,
    gitRemote: raw['gitRemote'] ?? null,
    contextSnapshot: raw['contextSnapshot'] ?? null,
    lastOpenedAt: migrateTimestamp(raw['lastOpenedAt'])
  })
};

function parseWorkspaceRecord(text: string, id: string): ParseResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { kind: 'corrupt' };
  }
  if (!isPlainObject(raw)) {
    return { kind: 'corrupt' };
  }

  const version = asNumber(raw['version']) ?? 1;
  if (version > REGISTRY_SCHEMA_VERSION) {
    return { kind: 'future' };
  }

  const migrated = migrate(raw, version);
  if (migrated === null) {
    return { kind: 'corrupt' };
  }

  const record = recordFromRaw(migrated, id);
  return record === null ? { kind: 'corrupt' } : { kind: 'record', record };
}

function migrate(raw: RawObject, fromVersion: number): RawObject | null {
  let current = raw;
  let version = fromVersion;
  while (version < REGISTRY_SCHEMA_VERSION) {
    const step = MIGRATIONS[version];
    if (step === undefined) {
      return null;
    }
    current = step(current);
    version = asNumber(current['version']) ?? version + 1;
  }
  return current;
}

function migrateTimestamp(value: unknown): unknown {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Date(value).toISOString();
  }
  return value;
}

/** Собирает запись из типизированного входа (путь `save`). */
function recordFromInput(input: WorkspaceRecordInput, now: Date): WorkspaceRecord {
  const id = assertWorkspaceId(input.id);
  const workspacePath = typeof input.path === 'string' ? input.path.trim() : '';
  if (workspacePath === '') {
    throw new WorkspaceRegistryError('в записи реестра отсутствует path воркспейса');
  }

  return {
    version: REGISTRY_SCHEMA_VERSION,
    id,
    path: cleanString(workspacePath),
    remote: cleanString(input.remote ?? REGISTRY_LOCAL_REMOTE),
    gitRemote: cleanStringOrNull(input.gitRemote ?? null),
    name: cleanString(input.name ?? path.basename(workspacePath)),
    lastOpenedAt: asIsoTimestamp(input.lastOpenedAt) ?? now.toISOString(),
    lastSessionId: cleanStringOrNull(input.lastSessionId ?? null),
    defaultModel: cleanStringOrNull(input.defaultModel ?? null),
    sandboxMode: asSandboxMode(input.sandboxMode ?? null),
    approvalPolicy: asApprovalPolicy(input.approvalPolicy ?? null),
    contextSnapshot: sanitizeContextSnapshot(input.contextSnapshot ?? null)
  };
}

/** Собирает запись из прочитанного JSON; `null` — файл не по схеме. */
function recordFromRaw(raw: RawObject, id: string): WorkspaceRecord | null {
  const workspacePath = asString(raw['path']);
  if (workspacePath === null || workspacePath.trim() === '') {
    return null;
  }
  const lastOpenedAt = asIsoTimestamp(raw['lastOpenedAt']);
  if (lastOpenedAt === null) {
    return null;
  }
  const recordId = asString(raw['id']);
  if (recordId !== null && recordId !== id) {
    return null;
  }

  return {
    version: REGISTRY_SCHEMA_VERSION,
    id,
    path: cleanString(workspacePath),
    remote: cleanString(asString(raw['remote']) ?? REGISTRY_LOCAL_REMOTE),
    gitRemote: cleanStringOrNull(asString(raw['gitRemote'])),
    name: cleanString(asString(raw['name']) ?? path.basename(workspacePath)),
    lastOpenedAt,
    lastSessionId: cleanStringOrNull(asString(raw['lastSessionId'])),
    defaultModel: cleanStringOrNull(asString(raw['defaultModel'])),
    sandboxMode: asSandboxMode(asString(raw['sandboxMode'])),
    approvalPolicy: asApprovalPolicy(asString(raw['approvalPolicy'])),
    contextSnapshot: sanitizeContextSnapshot(raw['contextSnapshot'])
  };
}

// --- санитизация ------------------------------------------------------------

/** Убирает из строки креденшелы и хвостовые пробелы. */
function cleanString(value: string): string {
  return stripCredentials(value.trim());
}

function cleanStringOrNull(value: string | null): string | null {
  if (value === null) {
    return null;
  }
  const cleaned = cleanString(value);
  return cleaned === '' ? null : cleaned;
}

/**
 * Вырезает секреты из произвольного значения: запрещённые ключи удаляются
 * рекурсивно, из строк вычищаются креденшелы.
 */
function sanitizeValue(value: unknown, depth = 0): unknown {
  if (depth > MAX_SANITIZE_DEPTH) {
    return undefined;
  }
  if (typeof value === 'string') {
    return stripCredentials(value);
  }
  if (Array.isArray(value)) {
    return value
      .map((item) => sanitizeValue(item, depth + 1))
      .filter((item) => item !== undefined);
  }
  if (isPlainObject(value)) {
    const result: RawObject = {};
    for (const [key, item] of Object.entries(value)) {
      if (SECRET_KEY_PATTERN.test(key)) {
        continue;
      }
      const sanitized = sanitizeValue(item, depth + 1);
      if (sanitized !== undefined) {
        result[key] = sanitized;
      }
    }
    return result;
  }
  return value;
}

function sanitizeContextSnapshot(value: unknown): ContextSnapshot | null {
  if (value === null || value === undefined) {
    return null;
  }
  const sanitized = sanitizeValue(value);
  if (!isPlainObject(sanitized)) {
    return null;
  }
  const hash = asString(sanitized['hash']);
  const files = asNumber(sanitized['files']);
  if (hash === null || files === null) {
    return null;
  }
  return {
    hash: cleanString(hash),
    skills: asStringArray(sanitized['skills']),
    rules: asStringArray(sanitized['rules']),
    files
  };
}

// --- мелкие помощники -------------------------------------------------------

function expandHome(directory: string): string {
  if (directory === '~') {
    return os.homedir();
  }
  if (directory.startsWith('~/') || directory.startsWith('~\\')) {
    return path.join(os.homedir(), directory.slice(2));
  }
  return directory;
}

function isPlainObject(value: unknown): value is RawObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === 'string');
}

function asIsoTimestamp(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  return Number.isNaN(Date.parse(value)) ? null : new Date(value).toISOString();
}

function asSandboxMode(value: string | null): SandboxMode | null {
  if (value === 'read-only' || value === 'workspace-write' || value === 'danger-full-access') {
    return value;
  }
  return null;
}

function asApprovalPolicy(value: string | null): ApprovalPolicy | null {
  if (value === 'ask' || value === 'auto' || value === 'never') {
    return value;
  }
  return null;
}

function isAlreadyExistsError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'EEXIST';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

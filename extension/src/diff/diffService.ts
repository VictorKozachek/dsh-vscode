/**
 * DiffService — предпросмотр правок, применение транзакцией и откат.
 *
 * Ядро без `vscode`: работает с файловой системой через порт `DiffFileSystem`
 * (в проде/тестах — `createNodeDiffFileSystem`), проверяет границы воркспейса,
 * хеши исходников и целостность записи. UI-часть (виртуальный документ и
 * `vscode.diff`, `WorkspaceEdit`, команда `DSH: Revert Last Edit`) — в
 * `diffController.ts` (#010).
 *
 * Поддерживаются правки:
 * - `replaceFile` — полная замена содержимого;
 * - `replaceText` — точечная замена найденного фрагмента (с проверкой
 *   неоднозначности);
 * - `replaceLines` — замена диапазона строк (1-based, включительно).
 *
 * Тесты — `tests/diff-service.test.mjs`.
 */

import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** Правка одного файла. */
export type EditOperation =
  | { readonly kind: 'replaceFile'; readonly content: string }
  | {
      readonly kind: 'replaceText';
      readonly find: string;
      readonly replace: string;
      readonly all?: boolean;
    }
  | {
      readonly kind: 'replaceLines';
      /** Первая строка диапазона, 1-based. */
      readonly startLine: number;
      /** Последняя строка диапазона, 1-based включительно; `startLine-1` — вставка. */
      readonly endLine: number;
      readonly lines: readonly string[];
    };

/** Предложенная правка файла. */
export interface ProposedFileEdit {
  /** Путь относительно корня воркспейса или абсолютный внутри него. */
  readonly path: string;
  readonly operations: readonly EditOperation[];
}

/** Предпросмотр одного файла. */
export interface FilePreview {
  readonly path: string;
  readonly relativePath: string;
  readonly originalContent: string;
  readonly newContent: string;
  readonly originalHash: string;
  readonly newHash: string;
  /** Файл существовал до правки (учитывается в проверке конфликта). */
  readonly existed: boolean;
  readonly created: boolean;
}

/** Предпросмотр пачки правок. */
export interface Preview {
  readonly id: string;
  readonly files: readonly FilePreview[];
  readonly createdAt: string;
}

/** Результат применения. */
export type ApplyResult =
  | { readonly status: 'applied'; readonly files: readonly string[] }
  | { readonly status: 'conflict'; readonly path: string }
  | { readonly status: 'failed'; readonly path: string; readonly error: string };

/** Результат отката. */
export type RevertResult =
  | { readonly status: 'reverted'; readonly files: readonly string[] }
  | { readonly status: 'empty' }
  | { readonly status: 'conflict'; readonly path: string }
  | { readonly status: 'failed'; readonly path: string; readonly error: string };

/** Проба пути: отличает «нет файла» от «есть, но не резолвится» (symlink/EACCES). */
export type DiffPathProbe =
  | { readonly status: 'ok'; readonly realPath: string }
  | { readonly status: 'missing' }
  | { readonly status: 'blocked'; readonly reason: string };

/** Порт файловой системы. */
export interface DiffFileSystem {
  readFile(filePath: string): Promise<string | null>;
  writeFile(filePath: string, content: string): Promise<void>;
  removeFile?(filePath: string): Promise<void>;
  realpath?(filePath: string): Promise<string | null>;
  /**
   * `lstat` + `realpath`: `ok` (реальный путь), `missing` (ENOENT),
   * `blocked` (компонент существует, но не резолвится — битая symlink/EACCES).
   * Для нового файла обязательна: иначе нельзя отличить отсутствие от битой
   * ссылки, и граница становится fail-open.
   */
  probePath?(filePath: string): Promise<DiffPathProbe>;
}

/** Ошибки сервиса с машинным кодом. */
export class DiffServiceError extends Error {
  readonly code:
    | 'outside-workspace'
    | 'ambiguous-match'
    | 'not-found'
    | 'preview-not-found'
    | 'empty-edit'
    | 'no-service';

  constructor(
    code: DiffServiceError['code'],
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = 'DiffServiceError';
    this.code = code;
  }
}

interface AppliedTransaction {
  readonly files: readonly {
    readonly absolutePath: string;
    readonly originalContent: string;
    readonly appliedContent: string;
    readonly created: boolean;
  }[];
}

/** Настройки сервиса. */
export interface DiffServiceOptions {
  readonly workspaceRoot: string;
  readonly fs?: DiffFileSystem | undefined;
  readonly now?: (() => Date) | undefined;
}

/**
 * Сервис правок: предпросмотр ничего не пишет, применение проверяет, что файлы
 * не изменились с момента предпросмотра, откат возвращает последнюю транзакцию.
 */
export class DiffService {
  readonly #root: string;
  readonly #fs: DiffFileSystem;
  readonly #now: () => Date;
  #preview: Preview | undefined;
  #lastApplied: AppliedTransaction | undefined;
  #previewCounter = 0;

  constructor(options: DiffServiceOptions) {
    this.#root = path.resolve(options.workspaceRoot);
    this.#fs = options.fs ?? createNodeDiffFileSystem();
    this.#now = options.now ?? (() => new Date());
  }

  /** Корень воркспейса. */
  get workspaceRoot(): string {
    return this.#root;
  }

  /** Последний предпросмотр. */
  get lastPreview(): Preview | undefined {
    return this.#preview;
  }

  /** Можно ли откатить последнюю транзакцию. */
  get canRevert(): boolean {
    return this.#lastApplied !== undefined;
  }

  /**
   * Считает новые содержимые и строчные правки, ничего не записывая.
   * Путь вне воркспейса → `DiffServiceError` с кодом `outside-workspace`.
   */
  async preview(edits: readonly ProposedFileEdit[]): Promise<Preview> {
    if (edits.length === 0) {
      throw new DiffServiceError('empty-edit', 'нет правок для предпросмотра');
    }

    // Один файл — одна запись: дубли путей объединяются, операции идут по порядку.
    const merged = new Map<string, { relativePath: string; operations: EditOperation[] }>();
    for (const edit of edits) {
      const absolutePath = await this.#resolveInsideRoot(edit.path);
      const entry = merged.get(absolutePath);
      if (entry === undefined) {
        merged.set(absolutePath, {
          relativePath: toPosix(path.relative(this.#root, absolutePath)),
          operations: [...edit.operations]
        });
      } else {
        entry.operations.push(...edit.operations);
      }
    }

    const files: FilePreview[] = [];
    for (const [absolutePath, entry] of merged) {
      const original = await this.#fs.readFile(absolutePath);
      const existed = original !== null;
      const baseContent = original ?? '';

      let content = baseContent;
      for (const operation of entry.operations) {
        content = applyOperation(content, operation);
      }

      files.push({
        path: absolutePath,
        relativePath: entry.relativePath,
        originalContent: baseContent,
        newContent: content,
        originalHash: hashContent(baseContent),
        newHash: hashContent(content),
        existed,
        created: !existed
      });
    }

    this.#previewCounter += 1;
    const preview: Preview = {
      id: `preview-${String(this.#previewCounter)}`,
      files,
      createdAt: this.#now().toISOString()
    };
    this.#preview = preview;
    return preview;
  }

  /**
   * Применяет предпросмотр транзакцией: сначала проверяет хеши всех файлов
   * (конфликт — ничего не пишем), затем пишет; при ошибке записи возвращает
   * уже записанные файлы к исходному содержимому.
   */
  async apply(previewId?: string): Promise<ApplyResult> {
    const preview = this.#preview;
    if (preview === undefined || (previewId !== undefined && preview.id !== previewId)) {
      throw new DiffServiceError('preview-not-found', 'предпросмотр не найден или устарел');
    }

    for (const file of preview.files) {
      const current = await this.#fs.readFile(file.path);
      if (file.created) {
        // Новый файл не должен появиться между preview и apply.
        if (current !== null) {
          return { status: 'conflict', path: file.relativePath };
        }
        continue;
      }
      if (current === null || hashContent(current) !== file.originalHash) {
        return { status: 'conflict', path: file.relativePath };
      }
    }

    const written: { file: FilePreview; originalContent: string }[] = [];
    for (const file of preview.files) {
      try {
        await this.#fs.writeFile(file.path, file.newContent);
        written.push({ file, originalContent: file.originalContent });
      } catch (error) {
        for (const item of [...written].reverse()) {
          try {
            if (item.file.created && this.#fs.removeFile !== undefined) {
              // Созданный файл при откате удаляется, а не остаётся пустым.
              await this.#fs.removeFile(item.file.path);
            } else {
              await this.#fs.writeFile(item.file.path, item.originalContent);
            }
          } catch {
            // откат best-effort: уже записанные файлы возвращаем, насколько можно
          }
        }
        return {
          status: 'failed',
          path: file.relativePath,
          error: error instanceof Error ? error.message : String(error)
        };
      }
    }

    this.#lastApplied = {
      files: preview.files.map((file) => ({
        absolutePath: file.path,
        originalContent: file.originalContent,
        appliedContent: file.newContent,
        created: file.created
      }))
    };
    this.#preview = undefined;
    return { status: 'applied', files: preview.files.map((file) => file.relativePath) };
  }

  /**
   * Проверяет, что файлы предпросмотра не изменились (для применения через
   * `WorkspaceEdit`: редактор даёт undo, сервис — проверку конфликта).
   */
  async verify(preview: Preview): Promise<{ readonly status: 'ok' } | { readonly status: 'conflict'; readonly path: string }> {
    for (const file of preview.files) {
      const current = await this.#fs.readFile(file.path);
      if (file.created) {
        // Новый файл не должен появиться между preview и apply.
        if (current !== null) {
          return { status: 'conflict', path: file.relativePath };
        }
        continue;
      }
      if (current === null || hashContent(current) !== file.originalHash) {
        return { status: 'conflict', path: file.relativePath };
      }
    }
    return { status: 'ok' };
  }

  /** Файлы, содержимое которых после применения не совпадает с newContent. */
  async changedSinceApply(preview: Preview): Promise<readonly string[]> {
    const changed: string[] = [];
    for (const file of preview.files) {
      const current = await this.#fs.readFile(file.path);
      if (current !== file.newContent) {
        changed.push(file.relativePath);
      }
    }
    return changed;
  }

  /** Совпадает ли реальное содержимое с предпросмотром (после WorkspaceEdit). */
  async checkApplied(
    preview: Preview
  ): Promise<{ readonly status: 'ok' } | { readonly status: 'mismatch'; readonly path: string }> {
    for (const file of preview.files) {
      const current = await this.#fs.readFile(file.path);
      if (current === null || current !== file.newContent) {
        return { status: 'mismatch', path: file.relativePath };
      }
    }
    return { status: 'ok' };
  }

  /** Запоминает транзакцию, применённую снаружи (через `WorkspaceEdit`). */
  markApplied(preview: Preview): void {
    this.#lastApplied = {
      files: preview.files.map((file) => ({
        absolutePath: file.path,
        originalContent: file.originalContent,
        appliedContent: file.newContent,
        created: file.created
      }))
    };
    this.#preview = undefined;
  }

  /**
   * Откат последней транзакции (`DSH: Revert Last Edit`). Если файл меняли
   * после применения — конфликт и ничего не откатываем.
   */
  async revertLast(): Promise<RevertResult> {
    const transaction = this.#lastApplied;
    if (transaction === undefined) {
      return { status: 'empty' };
    }

    for (const file of transaction.files) {
      const current = await this.#fs.readFile(file.absolutePath);
      if (current === null || hashContent(current) !== hashContent(file.appliedContent)) {
        return { status: 'conflict', path: toPosix(path.relative(this.#root, file.absolutePath)) };
      }
    }

    const restored: { file: (typeof transaction.files)[number] }[] = [];
    for (const file of [...transaction.files].reverse()) {
      try {
        if (file.created) {
          if (this.#fs.removeFile !== undefined) {
            await this.#fs.removeFile(file.absolutePath);
          } else {
            await this.#fs.writeFile(file.absolutePath, '');
          }
        } else {
          await this.#fs.writeFile(file.absolutePath, file.originalContent);
        }
        restored.push({ file });
      } catch (error) {
        // Транзакционный откат: уже восстановленные файлы возвращаем к
        // применённому содержимому, транзакцию не забываем.
        for (const item of restored) {
          try {
            await this.#fs.writeFile(item.file.absolutePath, item.file.appliedContent);
          } catch {
            // best-effort
          }
        }
        return {
          status: 'failed',
          path: toPosix(path.relative(this.#root, file.absolutePath)),
          error: error instanceof Error ? error.message : String(error)
        };
      }
    }

    this.#lastApplied = undefined;
    return {
      status: 'reverted',
      files: transaction.files.map((file) =>
        toPosix(path.relative(this.#root, file.absolutePath))
      )
    };
  }

  // --- внутреннее ----------------------------------------------------------

  /** Абсолютный путь внутри воркспейса (после realpath, если доступен). */
  async #resolveInsideRoot(inputPath: string): Promise<string> {
    const absolute = path.isAbsolute(inputPath)
      ? path.resolve(inputPath)
      : path.resolve(this.#root, inputPath);

    if (!isInside(this.#root, absolute)) {
      throw new DiffServiceError(
        'outside-workspace',
        `правка вне корня воркспейса: ${inputPath}`
      );
    }

    const probe = async (candidate: string): Promise<DiffPathProbe> => {
      if (this.#fs.probePath !== undefined) {
        try {
          return await this.#fs.probePath(candidate);
        } catch (error) {
          return {
            status: 'blocked',
            reason: error instanceof Error ? error.message : String(error)
          };
        }
      }
      if (this.#fs.realpath === undefined) {
        return { status: 'ok', realPath: candidate };
      }
      try {
        const resolved = await this.#fs.realpath(candidate);
        return resolved === null ? { status: 'missing' } : { status: 'ok', realPath: resolved };
      } catch (error) {
        return {
          status: 'blocked',
          reason: error instanceof Error ? error.message : String(error)
        };
      }
    };

    const rootProbe = await probe(this.#root);
    const realRoot = rootProbe.status === 'ok' ? rootProbe.realPath : this.#root;

    const target = await probe(absolute);
    if (target.status === 'ok') {
      if (!isInside(realRoot, target.realPath)) {
        throw new DiffServiceError(
          'outside-workspace',
          `правка ведёт за пределы воркспейса (symlink): ${inputPath}`
        );
      }
      return target.realPath;
    }
    if (target.status === 'blocked') {
      throw new DiffServiceError(
        'outside-workspace',
        `не удалось проверить реальный путь (${target.reason}): ${inputPath}`
      );
    }

    // `missing`: новый файл — ищем ближайшего существующего предка. Битая
    // ссылка или ошибка lstat/realpath у любого компонента — fail-closed.
    let candidate = path.dirname(absolute);
    const rest: string[] = [path.basename(absolute)];
    for (let depth = 0; depth < 64; depth += 1) {
      const ancestor = await probe(candidate);
      if (ancestor.status === 'blocked') {
        throw new DiffServiceError(
          'outside-workspace',
          `не удалось проверить предка (${ancestor.reason}): ${inputPath}`
        );
      }
      if (ancestor.status === 'ok') {
        const full = path.join(ancestor.realPath, ...rest);
        if (!isInside(realRoot, full)) {
          throw new DiffServiceError(
            'outside-workspace',
            `правка ведёт за пределы воркспейса (symlink): ${inputPath}`
          );
        }
        return full;
      }
      const parent = path.dirname(candidate);
      if (parent === candidate) {
        break;
      }
      rest.unshift(path.basename(candidate));
      candidate = parent;
    }

    throw new DiffServiceError(
      'outside-workspace',
      `не удалось проверить реальный путь (symlink): ${inputPath}`
    );
  }
}

/** Адаптер `node:fs` для DiffService (прод и тесты). */
export function createNodeDiffFileSystem(): DiffFileSystem {
  return {
    async readFile(filePath: string): Promise<string | null> {
      try {
        return await readFile(filePath, 'utf8');
      } catch {
        return null;
      }
    },
    async writeFile(filePath: string, content: string): Promise<void> {
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, content, 'utf8');
    },
    async removeFile(filePath: string): Promise<void> {
      await rm(filePath, { force: true });
    },
    async realpath(filePath: string): Promise<string | null> {
      try {
        return await realpath(filePath);
      } catch {
        return null;
      }
    },
    async probePath(filePath: string): Promise<DiffPathProbe> {
      try {
        await lstat(filePath);
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
        return { status: 'ok', realPath: await realpath(filePath) };
      } catch (error) {
        return {
          status: 'blocked',
          reason: error instanceof Error ? error.message : String(error)
        };
      }
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

/** Применяет одну операцию к содержимому файла. */
export function applyOperation(content: string, operation: EditOperation): string {
  switch (operation.kind) {
    case 'replaceFile':
      return operation.content;

    case 'replaceText': {
      if (operation.find === '') {
        throw new DiffServiceError('empty-edit', 'пустая строка поиска в replaceText');
      }
      const occurrences = countOccurrences(content, operation.find);
      if (occurrences === 0) {
        throw new DiffServiceError(
          'not-found',
          `фрагмент не найден: ${operation.find.slice(0, 80)}`
        );
      }
      if (occurrences > 1 && operation.all !== true) {
        throw new DiffServiceError(
          'ambiguous-match',
          `фрагмент встречается ${String(occurrences)} раз — нужен all: true`
        );
      }
      return content.split(operation.find).join(operation.replace);
    }

    case 'replaceLines': {
      const lines = splitContentLines(content);
      const { startLine, endLine, lines: replacement } = operation;
      if (startLine < 1 || endLine < startLine - 1 || endLine > lines.length) {
        throw new DiffServiceError(
          'not-found',
          `диапазон строк ${String(startLine)}..${String(endLine)} вне файла`
        );
      }
      const next = [
        ...lines.slice(0, startLine - 1),
        ...replacement,
        ...lines.slice(endLine)
      ];
      return joinContentLines(next, content.endsWith('\n'));
    }

    default:
      throw new DiffServiceError('empty-edit', 'неизвестная операция');
  }
}

/** SHA-256 содержимого — база для проверки конфликтов. */
export function hashContent(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

/** Строки без завершающего перевода строки (он учитывается отдельно). */
export function splitContentLines(content: string): string[] {
  const normalized = content.replace(/\r\n/g, '\n');
  const withoutTrailingNewline = normalized.endsWith('\n')
    ? normalized.slice(0, -1)
    : normalized;
  return withoutTrailingNewline === '' && normalized !== '' ? [''] : withoutTrailingNewline.split('\n');
}

function joinContentLines(lines: readonly string[], trailingNewline: boolean): string {
  return `${lines.join('\n')}${trailingNewline ? '\n' : ''}`;
}

function toPosix(value: string): string {
  return value.split(path.sep).join('/');
}

function isInside(root: string, target: string): boolean {
  const relativePath = path.relative(root, target);
  return relativePath === '' || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath));
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index >= 0) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

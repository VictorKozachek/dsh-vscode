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
import { mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
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

/** Минимальная замена строк для `vscode.TextEdit` / диффа. */
export interface TextEditSpec {
  readonly startLine: number;
  readonly endLine: number;
  readonly replacement: string;
}

/** Предпросмотр одного файла. */
export interface FilePreview {
  readonly path: string;
  readonly relativePath: string;
  readonly originalContent: string;
  readonly newContent: string;
  readonly originalHash: string;
  readonly newHash: string;
  readonly created: boolean;
  /** Минимальный набор строчных правок (для WorkspaceEdit). */
  readonly textEdits: readonly TextEditSpec[];
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
  | { readonly status: 'conflict'; readonly path: string };

/** Порт файловой системы. */
export interface DiffFileSystem {
  readFile(filePath: string): Promise<string | null>;
  writeFile(filePath: string, content: string): Promise<void>;
  removeFile?(filePath: string): Promise<void>;
  realpath?(filePath: string): Promise<string | null>;
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

    const files: FilePreview[] = [];
    for (const edit of edits) {
      const absolutePath = await this.#resolveInsideRoot(edit.path);
      const relativePath = toPosix(path.relative(this.#root, absolutePath));
      const original = (await this.#fs.readFile(absolutePath)) ?? '';
      const created = original === '' && (await this.#fileMissing(absolutePath));

      let content = original;
      for (const operation of edit.operations) {
        content = applyOperation(content, operation);
      }

      files.push({
        path: absolutePath,
        relativePath,
        originalContent: original,
        newContent: content,
        originalHash: hashContent(original),
        newHash: hashContent(content),
        created,
        textEdits: computeLineEdits(original, content)
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
      const current = (await this.#fs.readFile(file.path)) ?? '';
      if (hashContent(current) !== file.originalHash) {
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
            await this.#fs.writeFile(item.file.path, item.originalContent);
          } catch {
            // откат best-effort: исходное содержимое всё равно потеряно бы не было
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
      const current = (await this.#fs.readFile(file.path)) ?? '';
      if (hashContent(current) !== file.originalHash) {
        return { status: 'conflict', path: file.relativePath };
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
      const current = (await this.#fs.readFile(file.absolutePath)) ?? '';
      if (hashContent(current) !== hashContent(file.appliedContent)) {
        return { status: 'conflict', path: toPosix(path.relative(this.#root, file.absolutePath)) };
      }
    }

    for (const file of [...transaction.files].reverse()) {
      if (file.created) {
        if (this.#fs.removeFile !== undefined) {
          await this.#fs.removeFile(file.absolutePath);
        } else {
          await this.#fs.writeFile(file.absolutePath, '');
        }
        continue;
      }
      await this.#fs.writeFile(file.absolutePath, file.originalContent);
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

  async #fileMissing(absolutePath: string): Promise<boolean> {
    return (await this.#fs.readFile(absolutePath)) === null;
  }

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

    if (this.#fs.realpath === undefined) {
      return absolute;
    }

    const realRoot = (await this.#fs.realpath(this.#root)) ?? this.#root;
    const parent = path.dirname(absolute);
    const realParent = (await this.#fs.realpath(parent)) ?? parent;
    const target = (await this.#fs.realpath(absolute)) ?? path.join(realParent, path.basename(absolute));
    if (!isInside(realRoot, target)) {
      throw new DiffServiceError(
        'outside-workspace',
        `правка ведёт за пределы воркспейса (symlink): ${inputPath}`
      );
    }
    return target;
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
    }
  };
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

/**
 * Минимальная строчная правка между двумя текстами: общий префикс/суффикс
 * строк, середина — одна замена. Пусто, если тексты совпадают.
 */
export function computeLineEdits(original: string, next: string): readonly TextEditSpec[] {
  if (original === next) {
    return [];
  }
  const originalLines = splitContentLines(original);
  const nextLines = splitContentLines(next);

  let prefix = 0;
  while (
    prefix < originalLines.length &&
    prefix < nextLines.length &&
    originalLines[prefix] === nextLines[prefix]
  ) {
    prefix += 1;
  }

  let suffix = 0;
  while (
    suffix < originalLines.length - prefix &&
    suffix < nextLines.length - prefix &&
    originalLines[originalLines.length - 1 - suffix] === nextLines[nextLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const startLine = prefix + 1;
  const endLine = originalLines.length - suffix;
  const replacement = nextLines.slice(prefix, nextLines.length - suffix).join('\n');
  return [{ startLine, endLine, replacement }];
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

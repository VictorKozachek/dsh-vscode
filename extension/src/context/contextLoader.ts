/**
 * ContextLoader — контекст-пак воркспейса.
 *
 * Собирает всё, что нужно агенту при открытии папки (§7 спецификации):
 *
 * - правила: `AGENTS.md` в корне и вложенных каталогах, плюс пользовательский
 *   `~/.dsh/AGENTS.md`; наследование — ближайший файл первым, проект важнее
 *   пользовательских правил;
 * - `.dsh/workspace.json` — валидация и предупреждения о неизвестных ключах;
 * - скилы: `~/.dsh/skills`, `.dsh/skills`, `.agents/skills` (одинаковые имена —
 *   конфликт, проект побеждает, проигравший попадает в `conflicts`);
 * - память проекта (если включена в манифесте);
 * - индекс файлов: уважает `.gitignore` и `context.ignore`, не берёт секреты и
 *   бинарники, считает размеры и языки, ограничен `context.maxBytes`.
 *
 * Кэш — по хешу входов (путь + mtime + size). `watch()` пересобирает пак по
 * событиям ФС с debounce (по умолчанию 500 мс) и отдаёт его наружу (панель,
 * инспектор #013).
 *
 * Модуль не импортирует `vscode` и не имеет внешних зависимостей: всё
 * тестируется в Node (`tests/context-loader.test.mjs`).
 */

import { createHash } from 'node:crypto';
import { statSync, watch as watchFs, type FSWatcher } from 'node:fs';
import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

/** Лимит контекст-пака по умолчанию (совпадает с `dsh.context.maxBytes`). */
export const DEFAULT_MAX_BYTES = 262_144;

/** Сколько файлов индексировать по умолчанию. */
export const DEFAULT_MAX_FILES = 5_000;

/** Пауза watcher'а по умолчанию. */
export const DEFAULT_DEBOUNCE_MS = 500;

/** Каталоги, которые не индексируются никогда. */
const ALWAYS_IGNORED_DIRECTORIES = ['.git', 'node_modules', '.pnpm-store'];

/** Имена файлов, которые считаются секретами и не попадают в пак. */
const SECRET_FILE_PATTERNS: readonly RegExp[] = [
  /^\.env($|\.)/i,
  /^\.npmrc$/i,
  /^\.netrc$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)/i,
  /^(credentials|secrets?)(\.|$)/i,
  /\.(pem|key|p12|pfx|keystore)$/i
];

/** Расширения, которые считаются бинарными (не читаются). */
const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp', '.tiff',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.pdf', '.zip', '.gz', '.tgz', '.tar', '.7z', '.rar',
  '.exe', '.dll', '.so', '.dylib', '.bin',
  '.mp3', '.mp4', '.wav', '.ogg', '.webm',
  '.db', '.sqlite', '.sqlite3', '.vsix', '.map'
]);

/** Язык по расширению — для индекса и инспектора. */
const LANGUAGE_BY_EXTENSION: Readonly<Record<string, string>> = {
  '.ts': 'TypeScript',
  '.tsx': 'TypeScript',
  '.mts': 'TypeScript',
  '.js': 'JavaScript',
  '.mjs': 'JavaScript',
  '.cjs': 'JavaScript',
  '.jsx': 'JavaScript',
  '.json': 'JSON',
  '.jsonc': 'JSON',
  '.md': 'Markdown',
  '.mdx': 'Markdown',
  '.css': 'CSS',
  '.scss': 'SCSS',
  '.html': 'HTML',
  '.yml': 'YAML',
  '.yaml': 'YAML',
  '.toml': 'TOML',
  '.py': 'Python',
  '.go': 'Go',
  '.rs': 'Rust',
  '.java': 'Java',
  '.kt': 'Kotlin',
  '.rb': 'Ruby',
  '.php': 'PHP',
  '.c': 'C',
  '.h': 'C',
  '.cpp': 'C++',
  '.hpp': 'C++',
  '.cs': 'C#',
  '.sh': 'Shell',
  '.bash': 'Shell',
  '.zsh': 'Shell',
  '.ps1': 'PowerShell',
  '.sql': 'SQL',
  '.svg': 'SVG'
};

/** Sandbox-режим из манифеста. */
export type ManifestSandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';

/** Политика подтверждений из манифеста. */
export type ManifestApprovalPolicy = 'ask' | 'auto' | 'never';

/** `.dsh/workspace.json` (§4.3) + расширения, которые понимает воркспейс. */
export interface WorkspaceManifest {
  readonly name?: string;
  readonly defaultModel?: string;
  readonly sandboxMode?: ManifestSandboxMode;
  readonly approvalPolicy?: ManifestApprovalPolicy;
  readonly skills?: readonly string[];
  readonly rules?: readonly string[];
  readonly context?: {
    readonly ignore?: readonly string[];
    readonly maxBytes?: number;
  };
  readonly kanban?: { readonly enabled?: boolean };
  readonly memory?: { readonly enabled?: boolean; readonly path?: string };
}

/** Правило проекта (`AGENTS.md`). */
export interface RuleDocument {
  /** Путь относительно корня воркспейса (для пользовательского — с `~`). */
  readonly path: string;
  readonly source: 'project' | 'user' | 'builtin';
  /** Глубина каталога правила: 0 — корень воркспейса, больше — ближе к файлу. */
  readonly depth: number;
  readonly text: string;
  readonly bytes: number;
  readonly truncated: boolean;
}

/** Скил из `.dsh/skills`, `.agents/skills` или `~/.dsh/skills`. */
export interface SkillDescriptor {
  readonly name: string;
  readonly description: string;
  readonly path: string;
  readonly source: 'project' | 'user';
  readonly bytes: number;
}

/** Запись индекса файлов. */
export interface FileIndexEntry {
  readonly path: string;
  readonly bytes: number;
  readonly language: string;
  readonly binary: boolean;
}

/** Конфликт правил/скилов, который отдаётся инспектору (#013). */
export interface ContextConflict {
  readonly kind: 'skill';
  readonly name: string;
  readonly winner: string;
  readonly ignored: string;
}

/** Память проекта (если включена). */
export interface MemoryEntry {
  readonly path: string;
  readonly text: string;
}

/** Итоговый контекст-пак. */
export interface ContextPack {
  readonly workspacePath: string;
  readonly manifest: WorkspaceManifest | null;
  readonly manifestWarnings: readonly string[];
  readonly rules: readonly RuleDocument[];
  readonly skills: readonly SkillDescriptor[];
  readonly memory: readonly MemoryEntry[];
  readonly files: readonly FileIndexEntry[];
  readonly conflicts: readonly ContextConflict[];
  /** Пути, исключённые .gitignore/context.ignore/секреты/усечение (#013). */
  readonly ignored: readonly string[];
  readonly fingerprint: string;
  readonly generatedAt: string;
  readonly stats: {
    readonly files: number;
    readonly bytes: number;
    readonly byLanguage: Readonly<Record<string, number>>;
    readonly durationMs: number;
    readonly truncated: boolean;
  };
}

/** Настройки загрузчика. */
export interface ContextLoaderOptions {
  /** Корень воркспейса. */
  readonly root: string;
  /** Домашний каталог (для `~/.dsh`); по умолчанию `os.homedir()`. */
  readonly homeDirectory?: string | undefined;
  /** Debounce watcher'а. */
  readonly debounceMs?: number | undefined;
  /** Лимит файлов индекса. */
  readonly maxFiles?: number | undefined;
  /** Источник времени (подменяется в тестах). */
  readonly now?: (() => Date) | undefined;
  /** Лог диагностики. */
  readonly logger?: ((line: string) => void) | undefined;
}

/** Результат разбора `.dsh/workspace.json`. */
export interface ParsedManifest {
  readonly manifest: WorkspaceManifest | null;
  readonly warnings: readonly string[];
}

/** Пользовательские правила: `~/.dsh/AGENTS.md`. */
export const USER_RULES_FILE = 'AGENTS.md';

// --- игноры -----------------------------------------------------------------

interface IgnoreRule {
  readonly source: string;
  readonly negated: boolean;
  readonly directoryOnly: boolean;
  readonly regex: RegExp;
}

/**
 * Матчер `.gitignore`/`context.ignore`: последнее совпавшее правило выигрывает,
 * `!pattern` возвращает путь обратно, `dir/` — только каталоги.
 */
export class IgnoreMatcher {
  readonly #rules: readonly IgnoreRule[];

  constructor(patterns: readonly string[], source = '.gitignore') {
    const rules: IgnoreRule[] = [];
    for (const raw of patterns) {
      const rule = compileIgnoreRule(raw, source);
      if (rule !== null) {
        rules.push(rule);
      }
    }
    this.#rules = rules;
  }

  /** Игнорируется ли путь (относительный, через `/`). */
  ignores(relativePath: string, isDirectory = false): boolean {
    const normalized = relativePath.replace(/\\/g, '/').replace(/^\.?\//, '').replace(/\/+$/, '');
    if (normalized === '') {
      return false;
    }

    let ignored = false;
    for (const rule of this.#rules) {
      if (rule.directoryOnly && !isDirectory) {
        continue;
      }
      if (rule.regex.test(normalized)) {
        ignored = !rule.negated;
      }
    }
    return ignored;
  }

  get size(): number {
    return this.#rules.length;
  }
}

function compileIgnoreRule(rawLine: string, source: string): IgnoreRule | null {
  let line = rawLine.trim();
  if (line === '' || line.startsWith('#')) {
    return null;
  }

  const negated = line.startsWith('!');
  if (negated) {
    line = line.slice(1).trim();
  }
  if (line === '') {
    return null;
  }

  const directoryOnly = line.endsWith('/');
  if (directoryOnly) {
    line = line.replace(/\/+$/, '');
  }
  const anchored = line.startsWith('/');
  if (anchored) {
    line = line.slice(1);
  }

  const body = globToRegex(line);
  const regex = anchored
    ? new RegExp(`^${body}(?:/.*)?$`)
    : new RegExp(`(?:^|.*/)${body}(?:/.*)?$`);

  return { source, negated, directoryOnly, regex };
}

/** Перевод gitignore-паттерна в регулярное выражение. */
export function globToRegex(glob: string): string {
  let result = '';
  for (let index = 0; index < glob.length; index += 1) {
    const character = glob[index];
    if (character === '*') {
      if (glob[index + 1] === '*') {
        result += '.*';
        index += 1;
        if (glob[index + 1] === '/') {
          index += 1;
        }
      } else {
        result += '[^/]*';
      }
      continue;
    }
    if (character === '?') {
      result += '[^/]';
      continue;
    }
    result += escapeRegExp(character ?? '');
  }
  return result;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isSecretFile(fileName: string): boolean {
  return SECRET_FILE_PATTERNS.some((pattern) => pattern.test(fileName));
}

// --- манифест ---------------------------------------------------------------

const KNOWN_MANIFEST_KEYS = new Set([
  'name',
  'defaultModel',
  'sandboxMode',
  'approvalPolicy',
  'skills',
  'rules',
  'context',
  'kanban',
  'memory'
]);

const SANDBOX_MODES: readonly string[] = ['read-only', 'workspace-write', 'danger-full-access'];
const APPROVAL_POLICIES: readonly string[] = ['ask', 'auto', 'never'];

/**
 * Разбирает `.dsh/workspace.json`. Битый JSON не роняет сборку пака: возвращает
 * `manifest: null` и предупреждение. Неизвестные ключи — предупреждения.
 */
export function parseWorkspaceManifest(text: string): ParsedManifest {
  const warnings: string[] = [];
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    warnings.push(`.dsh/workspace.json: битый JSON (${describeError(error)}) — манифест проигнорирован`);
    return { manifest: null, warnings };
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    warnings.push('.dsh/workspace.json: ожидался объект — манифест проигнорирован');
    return { manifest: null, warnings };
  }

  const record = raw as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!KNOWN_MANIFEST_KEYS.has(key)) {
      warnings.push(`.dsh/workspace.json: неизвестный ключ «${key}» — игнорируется`);
    }
  }

  const manifest: {
    -readonly [K in keyof WorkspaceManifest]: WorkspaceManifest[K];
  } = {};

  const name = asString(record['name']);
  if (name !== null) {
    manifest.name = name;
  }
  const defaultModel = asString(record['defaultModel']);
  if (defaultModel !== null) {
    manifest.defaultModel = defaultModel;
  }
  const sandboxMode = asString(record['sandboxMode']);
  if (sandboxMode !== null) {
    if (SANDBOX_MODES.includes(sandboxMode)) {
      manifest.sandboxMode = sandboxMode as ManifestSandboxMode;
    } else {
      warnings.push(`.dsh/workspace.json: sandboxMode «${sandboxMode}» неизвестен`);
    }
  }
  const approvalPolicy = asString(record['approvalPolicy']);
  if (approvalPolicy !== null) {
    if (APPROVAL_POLICIES.includes(approvalPolicy)) {
      manifest.approvalPolicy = approvalPolicy as ManifestApprovalPolicy;
    } else {
      warnings.push(`.dsh/workspace.json: approvalPolicy «${approvalPolicy}» неизвестен`);
    }
  }

  const skills = asStringArray(record['skills']);
  if (skills !== null) {
    manifest.skills = skills;
  }
  const rules = asStringArray(record['rules']);
  if (rules !== null) {
    manifest.rules = rules;
  }

  const context = asRecord(record['context']);
  if (context !== null) {
    const ignore = asStringArray(context['ignore']);
    const maxBytes = asNumber(context['maxBytes']);
    const parsedContext: { ignore?: readonly string[]; maxBytes?: number } = {};
    if (ignore !== null) {
      parsedContext.ignore = ignore;
    }
    if (maxBytes !== null) {
      parsedContext.maxBytes = maxBytes;
    }
    manifest.context = parsedContext;
  }

  const kanban = asRecord(record['kanban']);
  if (kanban !== null) {
    const enabled = asBoolean(kanban['enabled']);
    manifest.kanban = enabled === null ? {} : { enabled };
  }

  const memory = asRecord(record['memory']);
  if (memory !== null) {
    const enabled = asBoolean(memory['enabled']);
    const memoryPath = asString(memory['path']);
    const parsedMemory: { enabled?: boolean; path?: string } = {};
    if (enabled !== null) {
      parsedMemory.enabled = enabled;
    }
    if (memoryPath !== null) {
      parsedMemory.path = memoryPath;
    }
    manifest.memory = parsedMemory;
  }

  return { manifest, warnings };
}

// --- правила и скилы --------------------------------------------------------

/** Приоритет источника: проект важнее пользовательских правил. */
export function rulePriority(rule: RuleDocument): number {
  return (rule.source === 'project' ? 1000 : rule.source === 'user' ? 500 : 0) + rule.depth;
}

/**
 * Правила, применимые к файлу: только предки каталога файла, ближайшее первым
 * (наследование с приоритетом ближайшего), проект — раньше пользовательских.
 */
export function rulesFor(pack: ContextPack, relativeFilePath: string): readonly RuleDocument[] {
  const fileDirectory = path.posix.dirname(relativeFilePath.replace(/\\/g, '/'));
  return [...pack.rules]
    .filter((rule) => {
      if (rule.source === 'user') {
        return true;
      }
      if (rule.depth === 0) {
        return true;
      }
      const ruleDirectory = path.posix.dirname(rule.path);
      return fileDirectory === ruleDirectory || fileDirectory.startsWith(`${ruleDirectory}/`);
    })
    .sort((left, right) => rulePriority(right) - rulePriority(left));
}

/** Разбор YAML-фронтматтера `SKILL.md` (плоские `key: value`). */
export function parseSkillFrontmatter(text: string): { name: string | null; description: string | null } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (match === null || match[1] === undefined) {
    return { name: null, description: null };
  }
  const fields: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const assignment = /^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.+)$/.exec(line.trim());
    if (assignment !== null && assignment[1] !== undefined && assignment[2] !== undefined) {
      fields[assignment[1].toLowerCase()] = unquote(assignment[2]);
    }
  }
  return { name: fields['name'] ?? null, description: fields['description'] ?? null };
}

// --- индекс -----------------------------------------------------------------

/** Язык по имени файла. */
export function detectLanguage(fileName: string): string {
  const extension = path.extname(fileName).toLowerCase();
  return LANGUAGE_BY_EXTENSION[extension] ?? 'Other';
}

/** Бинарный ли файл — по расширению (содержимое не читается). */
export function isBinaryFile(fileName: string): boolean {
  return BINARY_EXTENSIONS.has(path.extname(fileName).toLowerCase());
}

// --- загрузчик --------------------------------------------------------------

interface RuleFileRef {
  readonly relativePath: string;
  readonly size: number;
  readonly mtimeMs: number;
}

interface Collected {
  readonly files: readonly FoundFile[];
  readonly ruleFiles: readonly RuleFileRef[];
  readonly inputs: readonly string[];
  readonly ignored: readonly string[];
}

interface FoundFile {
  readonly relativePath: string;
  readonly absolutePath: string;
  readonly size: number;
  readonly mtimeMs: number;
}

/** Загрузчик контекста воркспейса. */
export class ContextLoader {
  readonly #root: string;
  readonly #home: string;
  readonly #debounceMs: number;
  readonly #maxFiles: number;
  readonly #now: () => Date;
  readonly #log: (line: string) => void;

  #cachedPack: ContextPack | undefined;
  #cachedFingerprint: string | undefined;
  #lastCacheHit = false;
  #lastDurationMs = 0;
  #watcher: FSWatcher | undefined;
  #watcherTimer: NodeJS.Timeout | undefined;
  #watchListeners = new Set<(pack: ContextPack) => void>();
  /** Пути из манифеста (rules/skills/memory) — их изменения тоже пересобирают пак. */
  #manifestWatchPaths: string[] = [];
  #disposed = false;

  constructor(options: ContextLoaderOptions) {
    this.#root = path.resolve(options.root);
    this.#home = options.homeDirectory ?? os.homedir();
    this.#debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.#maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
    this.#now = options.now ?? (() => new Date());
    this.#log = options.logger ?? (() => undefined);
  }

  /** Корень воркспейса. */
  get root(): string {
    return this.#root;
  }

  /** Был ли последний `load()` из кэша. */
  get lastCacheHit(): boolean {
    return this.#lastCacheHit;
  }

  /** Длительность последнего `load()`, мс. */
  get lastDurationMs(): number {
    return this.#lastDurationMs;
  }

  /** Собирает пак (или берёт из кэша по хешу входов). */
  async load(): Promise<ContextPack> {
    const started = performance.now();
    const collected = await this.#collect();
    const fingerprint = fingerprintOf(collected.inputs);

    if (this.#cachedPack !== undefined && this.#cachedFingerprint === fingerprint) {
      this.#lastCacheHit = true;
      const cached: ContextPack = {
        ...this.#cachedPack,
        stats: { ...this.#cachedPack.stats, durationMs: roundMs(performance.now() - started) }
      };
      this.#lastDurationMs = cached.stats.durationMs;
      return cached;
    }

    this.#lastCacheHit = false;
    const pack = await this.#buildPack(collected, fingerprint, started);
    this.#cachedPack = pack;
    this.#cachedFingerprint = fingerprint;
    this.#lastDurationMs = pack.stats.durationMs;
    return pack;
  }

  /** Пересобирает пак без кэша (DSH: Reload Context). */
  async reload(): Promise<ContextPack> {
    this.#cachedPack = undefined;
    this.#cachedFingerprint = undefined;
    return this.load();
  }

  /**
   * Следит за файлами воркспейса (правила, манифест, скилы) и пересобирает пак
   * с debounce. Возвращает функцию отписки.
   */
  watch(listener: (pack: ContextPack) => void): () => void {
    if (this.#disposed) {
      return () => undefined;
    }
    this.#watchListeners.add(listener);
    this.#ensureWatcher();
    return () => {
      this.#watchListeners.delete(listener);
      if (this.#watchListeners.size === 0) {
        this.#stopWatcher();
      }
    };
  }

  dispose(): void {
    this.#disposed = true;
    this.#watchListeners.clear();
    this.#manifestWatchPaths = [];
    this.#stopWatcher();
    this.#cachedPack = undefined;
    this.#cachedFingerprint = undefined;
  }

  // --- сбор входов ---------------------------------------------------------

  async #collect(): Promise<Collected> {
    const manifest = await this.#readText('.dsh/workspace.json');
    const gitignore = await this.#readText('.gitignore');
    const parsed = manifest === null ? { manifest: null, warnings: [] } : parseWorkspaceManifest(manifest.text);

    const patterns = [
      ...splitLines(gitignore?.text ?? ''),
      ...(parsed.manifest?.context?.ignore ?? [])
    ];
    const matcher = new IgnoreMatcher(patterns, 'ignore');
    const walked = await this.#walk(matcher);

    const inputs: string[] = [];
    if (manifest !== null) {
      inputs.push(`manifest:${String(manifest.mtimeMs)}:${String(manifest.size)}`);
    }
    if (gitignore !== null) {
      inputs.push(`gitignore:${String(gitignore.mtimeMs)}:${String(gitignore.size)}`);
    }
    for (const file of walked.files) {
      inputs.push(`${file.relativePath}:${String(file.mtimeMs)}:${String(file.size)}`);
    }
    for (const rule of walked.ruleFiles) {
      inputs.push(`rule:${rule.relativePath}:${String(rule.mtimeMs)}:${String(rule.size)}`);
    }
    // Правила из манифеста могут не попасть в индекс (например, каталог в
    // .gitignore) — без их mtime кэш не инвалидировался бы.
    for (const rule of await this.#loadableManifestRules(parsed.manifest)) {
      const stats = await stat(rule.absolutePath).catch(() => null);
      if (stats !== null) {
        inputs.push(
          `manifest-rule:${rule.relativePath}:${String(stats.mtimeMs)}:${String(stats.size)}`
        );
      }
    }

    for (const directory of await this.#skillsDirectories(parsed.manifest)) {
      const found = await this.#listSkillFiles(directory.absolute, directory.relative);
      for (const file of found) {
        inputs.push(`skill:${file.relativePath}:${String(file.mtimeMs)}:${String(file.size)}`);
      }
    }

    const userRules = await this.#statFile(path.join(this.#home, '.dsh', USER_RULES_FILE));
    if (userRules !== null) {
      inputs.push(`user-rules:${String(userRules.mtimeMs)}:${String(userRules.size)}`);
    }

    const memoryDirectory = await this.#memoryDirectory(parsed.manifest);
    if (memoryDirectory !== null) {
      const found = await this.#listMarkdownFiles(memoryDirectory.absolute, memoryDirectory.relative);
      for (const file of found) {
        inputs.push(`memory:${file.relativePath}:${String(file.mtimeMs)}:${String(file.size)}`);
      }
    }

    return {
      files: walked.files,
      ruleFiles: walked.ruleFiles,
      inputs,
      ignored: walked.ignored
    };
  }

  async #walk(
    matcher: IgnoreMatcher
  ): Promise<{ files: FoundFile[]; ruleFiles: RuleFileRef[]; ignored: string[] }> {
    const files: FoundFile[] = [];
    const ruleFiles: RuleFileRef[] = [];
    const ignored: string[] = [];

    const visit = async (directory: string): Promise<void> => {
      if (this.#disposed || files.length >= this.#maxFiles) {
        return;
      }
      let entries;
      try {
        entries = await readdir(directory, { withFileTypes: true });
      } catch {
        return;
      }
      entries.sort((left, right) => left.name.localeCompare(right.name));

      const subdirectories: string[] = [];

      for (const entry of entries) {
        const absolutePath = path.join(directory, entry.name);
        const relativePath = toPosix(path.relative(this.#root, absolutePath));

        if (entry.name === '.git') {
          continue; // .git бывает и каталогом, и файлом (git worktree) — не индексируем
        }
        if (entry.isSymbolicLink()) {
          ignored.push(relativePath);
          continue; // циклы и внешние ссылки не обходим
        }
        if (entry.isDirectory()) {
          if (ALWAYS_IGNORED_DIRECTORIES.includes(entry.name) || matcher.ignores(relativePath, true)) {
            ignored.push(`${relativePath}/`);
            continue;
          }
          subdirectories.push(absolutePath);
          continue;
        }
        if (!entry.isFile()) {
          continue;
        }
        if (entry.name === USER_RULES_FILE) {
          const ruleStats = statSync(absolutePath, { throwIfNoEntry: false });
          if (ruleStats !== undefined && ruleStats.isFile()) {
            ruleFiles.push({ relativePath, size: ruleStats.size, mtimeMs: ruleStats.mtimeMs });
          }
        }
        if (isSecretFile(entry.name) || matcher.ignores(relativePath, false)) {
          ignored.push(relativePath);
          continue;
        }
        if (files.length >= this.#maxFiles) {
          break;
        }

        // Синхронный stat: на 1000 файлов это единицы миллисекунд, тогда как
        // 1000 асинхронных stat через thread pool стоят сотни миллисекунд и
        // не проходят бюджет «< 300 мс на 1000 файлов».
        const stats = statSync(absolutePath, { throwIfNoEntry: false });
        if (stats === undefined || !stats.isFile()) {
          continue;
        }
        files.push({
          relativePath,
          absolutePath,
          size: stats.size,
          mtimeMs: stats.mtimeMs
        });
      }

      for (const subdirectory of subdirectories) {
        if (this.#disposed || files.length >= this.#maxFiles) {
          return;
        }
        await visit(subdirectory);
      }
    };

    await visit(this.#root);
    return { files, ruleFiles, ignored };
  }

  // --- сборка пака ---------------------------------------------------------

  async #buildPack(
    collected: Collected,
    fingerprint: string,
    started: number
  ): Promise<ContextPack> {
    const manifest = await this.#readText('.dsh/workspace.json');
    const parsed = manifest === null ? { manifest: null, warnings: [] } : parseWorkspaceManifest(manifest.text);
    const maxBytes = parsed.manifest?.context?.maxBytes ?? DEFAULT_MAX_BYTES;
    const manifestWarnings = [...parsed.warnings, ...(await this.#validateManifest(parsed.manifest))];
    this.#manifestWatchPaths = this.#collectManifestWatchPaths(parsed.manifest);

    const rules = await this.#loadRules(collected.ruleFiles, parsed.manifest, maxBytes);
    const skills = await this.#loadSkills(parsed.manifest);
    const memory = await this.#loadMemory(parsed.manifest, maxBytes);

    const conflicts: ContextConflict[] = [];
    for (const [name, group] of groupByName(skills)) {
      if (group.length > 1) {
        const winner = group.find((skill) => skill.source === 'project') ?? group[0];
        if (winner !== undefined) {
          for (const skill of group) {
            if (skill !== winner) {
              conflicts.push({ kind: 'skill', name, winner: winner.path, ignored: skill.path });
            }
          }
        }
      }
    }

    let bytes = 0;
    let truncated = false;
    const files: FileIndexEntry[] = [];
    const ignored = [...collected.ignored];
    const byLanguage: Record<string, number> = {};
    for (const file of collected.files) {
      if (bytes + file.size > maxBytes) {
        truncated = true;
        ignored.push(file.relativePath);
        continue;
      }
      bytes += file.size;
      const language = detectLanguage(file.relativePath);
      byLanguage[language] = (byLanguage[language] ?? 0) + 1;
      files.push({
        path: file.relativePath,
        bytes: file.size,
        language,
        binary: isBinaryFile(file.relativePath)
      });
    }
    if (collected.files.length >= this.#maxFiles) {
      truncated = true;
    }

    const durationMs = roundMs(performance.now() - started);
    return {
      workspacePath: this.#root,
      manifest: parsed.manifest,
      manifestWarnings,
      rules,
      skills: skills.filter((skill) => !conflicts.some((conflict) => conflict.ignored === skill.path)),
      memory,
      files,
      conflicts,
      ignored,
      fingerprint,
      generatedAt: this.#now().toISOString(),
      stats: {
        files: files.length,
        bytes,
        byLanguage,
        durationMs,
        truncated
      }
    };
  }

  async #loadRules(
    ruleFiles: readonly RuleFileRef[],
    manifest: WorkspaceManifest | null,
    maxBytes: number
  ): Promise<readonly RuleDocument[]> {
    const documents: RuleDocument[] = [];
    const seen = new Set<string>();
    let remaining = maxBytes;

    const addRule = (
      key: string,
      source: RuleDocument['source'],
      relativePath: string,
      text: { text: string; size: number }
    ): void => {
      if (seen.has(key)) {
        return;
      }
      seen.add(key);
      const clipped = truncateToBytes(text.text, remaining);
      remaining = Math.max(0, remaining - Buffer.byteLength(clipped.text));
      const directory = toPosix(path.posix.dirname(relativePath));
      documents.push({
        path: key,
        source,
        depth: directory === '.' ? 0 : directory.split('/').length,
        text: clipped.text,
        bytes: text.size,
        truncated: clipped.truncated
      });
    };

    for (const file of ruleFiles) {
      const text = await this.#readText(file.relativePath);
      if (text === null) {
        continue;
      }
      addRule(file.relativePath, 'project', file.relativePath, text);
    }

    // `rules` из манифеста (§4.3): дополнительные файлы правил проекта.
    // Проходят те же границы, что и остальной пак: внутри воркспейса после
    // realpath (symlink наружу и symlink на секрет не проходят) и не
    // секретные/служебные имена.
    for (const rule of await this.#loadableManifestRules(manifest)) {
      const text = await this.#readAbsolute(rule.absolutePath);
      if (text === null) {
        continue;
      }
      addRule(rule.relativePath, 'project', rule.relativePath, text);
    }

    const userRulesPath = path.join(this.#home, '.dsh', USER_RULES_FILE);
    if ((await this.#statFile(userRulesPath)) !== null) {
      const text = await readTextFile(userRulesPath);
      if (text !== null) {
        const clipped = truncateToBytes(text, remaining);
        remaining = Math.max(0, remaining - Buffer.byteLength(clipped.text));
        documents.push({
          path: `~/.dsh/${USER_RULES_FILE}`,
          source: 'user',
          depth: 0,
          text: clipped.text,
          bytes: Buffer.byteLength(text),
          truncated: clipped.truncated
        });
      }
    }

    return documents.sort((left, right) => rulePriority(right) - rulePriority(left));
  }

  async #loadSkills(manifest: WorkspaceManifest | null): Promise<readonly SkillDescriptor[]> {
    const skills: SkillDescriptor[] = [];
    for (const directory of await this.#skillsDirectories(manifest)) {
      const files = await this.#listSkillFiles(directory.absolute, directory.relative);
      for (const file of files) {
        const text = await readTextFile(file.absolutePath);
        if (text === null) {
          continue;
        }
        const frontmatter = parseSkillFrontmatter(text);
        const directoryName = path.basename(path.dirname(file.absolutePath));
        skills.push({
          name: frontmatter.name ?? directoryName,
          description: frontmatter.description ?? firstMeaningfulLine(text),
          path: `${directory.relative}/${directoryName}`,
          source: directory.source,
          bytes: Buffer.byteLength(text)
        });
      }
    }
    return skills;
  }

  async #loadMemory(
    manifest: WorkspaceManifest | null,
    maxBytes: number
  ): Promise<readonly MemoryEntry[]> {
    const directory = await this.#memoryDirectory(manifest);
    if (directory === null) {
      return [];
    }
    const files = await this.#listMarkdownFiles(directory.absolute, directory.relative);
    const memory: MemoryEntry[] = [];
    let remaining = maxBytes;
    for (const file of files) {
      if (remaining <= 0) {
        break;
      }
      if (isSecretFile(path.basename(file.relativePath))) {
        continue;
      }
      const text = await readTextFile(file.absolutePath);
      if (text === null) {
        continue;
      }
      const clipped = truncateToBytes(text, remaining);
      remaining = Math.max(0, remaining - Buffer.byteLength(clipped.text));
      memory.push({ path: file.relativePath, text: clipped.text });
    }
    return memory;
  }

  async #skillsDirectories(
    manifest: WorkspaceManifest | null
  ): Promise<readonly { absolute: string; relative: string; source: 'project' | 'user' }[]> {
    const directories: { absolute: string; relative: string; source: 'project' | 'user' }[] = [
      { absolute: path.join(this.#home, '.dsh', 'skills'), relative: '~/.dsh/skills', source: 'user' },
      { absolute: path.join(this.#root, '.dsh', 'skills'), relative: '.dsh/skills', source: 'project' },
      { absolute: path.join(this.#root, '.agents', 'skills'), relative: '.agents/skills', source: 'project' }
    ];

    // `skills` из манифеста (§4.3): дополнительные каталоги скилов проекта.
    const seen = new Set(directories.map((directory) => directory.absolute));
    for (const entry of manifest?.skills ?? []) {
      const relative = normalizeRelativePath(entry).replace(/\/+$/, '');
      if ((await this.#manifestPathRejection(relative, 'directory')) !== null) {
        continue;
      }
      const absolute = await this.#resolveInsideRoot(relative);
      if (absolute === null || seen.has(absolute)) {
        continue;
      }
      seen.add(absolute);
      directories.push({ absolute, relative, source: 'project' });
    }
    return directories;
  }

  /**
   * Каталог памяти проекта. Только внутри воркспейса: `../outside`, абсолютный
   * путь снаружи и симлинк наружу отбрасываются (иначе в контекст агента
   * утекали бы произвольные `.md` с машины).
   */
  async #memoryDirectory(
    manifest: WorkspaceManifest | null
  ): Promise<{ absolute: string; relative: string } | null> {
    if (manifest?.memory?.enabled !== true) {
      return null;
    }
    const relative = normalizeRelativePath(manifest.memory.path ?? '.dsh/memory');

    // Та же проверка, что у rules/skills: пустой путь, выход за воркспейс,
    // секретный/служебный путь (в том числе через симлинк внутри root),
    // не-каталог. Иначе предупреждение говорило бы одно, а пак читал другое.
    const rejection = await this.#manifestPathRejection(relative, 'directory');
    if (rejection !== null) {
      this.#log(`ContextLoader: memory.path «${relative}» ${rejection} — память не читается`);
      return null;
    }

    const absolute = await this.#resolveInsideRoot(relative);
    if (absolute === null) {
      return null;
    }
    return { absolute, relative };
  }

  /** Проверка путей из манифеста: всё должно лежать внутри воркспейса. */
  #isSafeManifestPath(relativePath: string): boolean {
    return isPathInside(this.#root, path.resolve(this.#root, relativePath));
  }

  /** Предупреждения манифеста про пути, которые не будут прочитаны. */
  async #validateManifest(manifest: WorkspaceManifest | null): Promise<readonly string[]> {
    if (manifest === null) {
      return [];
    }
    const warnings: string[] = [];

    for (const entry of manifest.rules ?? []) {
      const relative = normalizeRelativePath(entry);
      const reason = await this.#manifestPathRejection(relative, 'file');
      if (reason !== null) {
        warnings.push(`.dsh/workspace.json: rules «${entry}» ${reason} — пропущено`);
      }
    }

    for (const entry of manifest.skills ?? []) {
      const relative = normalizeRelativePath(entry).replace(/\/+$/, '');
      const reason = await this.#manifestPathRejection(relative, 'directory');
      if (reason !== null) {
        warnings.push(`.dsh/workspace.json: skills «${entry}» ${reason} — пропущено`);
      }
    }

    if (manifest.memory?.enabled === true && manifest.memory.path !== undefined) {
      const relative = normalizeRelativePath(manifest.memory.path);
      const reason = await this.#manifestPathRejection(relative, 'directory');
      if (reason !== null) {
        warnings.push(
          `.dsh/workspace.json: memory.path «${manifest.memory.path}» ${reason} — память не читается`
        );
      }
    }

    return warnings;
  }

  /**
   * Причина, по которой путь из манифеста не будет прочитан (`null` — можно):
   * пустой, вне воркспейса, секретный/служебный, симлинк наружу, не найден,
   * не того типа.
   */
  async #manifestPathRejection(
    relativePath: string,
    kind: 'file' | 'directory'
  ): Promise<string | null> {
    if (relativePath.trim() === '') {
      return 'пустой путь';
    }
    if (!this.#isSafeManifestPath(relativePath)) {
      return 'вне воркспейса';
    }
    if (this.#isForbiddenManifestPath(relativePath)) {
      return 'секретный или служебный путь';
    }
    const absolute = await this.#resolveInsideRoot(relativePath);
    if (absolute === null) {
      return 'не найден или ведёт за пределы воркспейса (symlink)';
    }
    // Симлинк внутри воркспейса может вести на секрет/служебный файл:
    // проверяем уже реальный путь, а не запрошенный.
    const realRoot = await realpath(this.#root).catch(() => this.#root);
    const realRelative = toPosix(path.relative(realRoot, absolute));
    if (this.#isForbiddenManifestPath(realRelative)) {
      return 'ведёт на секретный или служебный путь (symlink)';
    }
    const stats = await stat(absolute).catch(() => null);
    if (stats === null) {
      return 'не найден';
    }
    if (kind === 'file' && !stats.isFile()) {
      return 'не файл';
    }
    if (kind === 'directory' && !stats.isDirectory()) {
      return 'не каталог';
    }
    return null;
  }

  /** Файлы правил из манифеста, прошедшие проверки границ и секретов. */
  async #loadableManifestRules(
    manifest: WorkspaceManifest | null
  ): Promise<readonly { relativePath: string; absolutePath: string }[]> {
    const rules: { relativePath: string; absolutePath: string }[] = [];
    const seen = new Set<string>();
    for (const entry of manifest?.rules ?? []) {
      const relativePath = normalizeRelativePath(entry);
      if (seen.has(relativePath)) {
        continue;
      }
      if ((await this.#manifestPathRejection(relativePath, 'file')) !== null) {
        continue;
      }
      const absolutePath = await this.#resolveInsideRoot(relativePath);
      if (absolutePath === null) {
        continue;
      }
      seen.add(relativePath);
      rules.push({ relativePath, absolutePath });
    }
    return rules;
  }

  /** Относительные пути из манифеста, за которыми следит watcher. */
  #collectManifestWatchPaths(manifest: WorkspaceManifest | null): string[] {
    if (manifest === null) {
      return [];
    }
    const paths = new Set<string>();
    for (const entry of manifest.rules ?? []) {
      const relative = normalizeRelativePath(entry);
      if (relative !== '') {
        paths.add(relative);
      }
    }
    for (const entry of manifest.skills ?? []) {
      const relative = normalizeRelativePath(entry).replace(/\/+$/, '');
      if (relative !== '') {
        paths.add(relative);
      }
    }
    if (manifest.memory?.enabled === true && manifest.memory.path !== undefined) {
      const relative = normalizeRelativePath(manifest.memory.path).replace(/\/+$/, '');
      if (relative !== '') {
        paths.add(relative);
      }
    }
    return [...paths];
  }

  /** Изменение файла из манифеста (rules/skills/memory) тоже пересобирает пак. */
  #isRelevantChange(filename: string | null): boolean {
    if (filename === null) {
      return true;
    }
    if (isRelevantContextFile(filename)) {
      return true;
    }
    const normalized = filename.replace(/\\/g, '/');
    return this.#manifestWatchPaths.some(
      (watched) => normalized === watched || normalized.startsWith(`${watched}/`)
    );
  }

  /** Реальный путь внутри воркспейса или `null` (symlink наружу не проходит). */
  async #resolveInsideRoot(relativePath: string): Promise<string | null> {
    if (!this.#isSafeManifestPath(relativePath)) {
      return null;
    }
    try {
      const real = await realpath(path.resolve(this.#root, relativePath));
      const realRoot = await realpath(this.#root).catch(() => this.#root);
      return isPathInside(realRoot, real) ? real : null;
    } catch {
      return null;
    }
  }

  /** Секретные и служебные пути из манифеста не читаются никогда. */
  #isForbiddenManifestPath(relativePath: string): boolean {
    const segments = relativePath.split('/');
    if (segments.some((segment) => ALWAYS_IGNORED_DIRECTORIES.includes(segment))) {
      return true;
    }
    return isSecretFile(path.posix.basename(relativePath));
  }

  /** Чтение по абсолютному пути (после проверки границ). */
  async #readAbsolute(
    absolutePath: string
  ): Promise<{ text: string; size: number; mtimeMs: number } | null> {
    try {
      const stats = await stat(absolutePath);
      if (!stats.isFile()) {
        return null;
      }
      const text = await readFile(absolutePath, 'utf8');
      return { text, size: stats.size, mtimeMs: stats.mtimeMs };
    } catch {
      return null;
    }
  }

  async #listSkillFiles(
    directory: string,
    relativeDirectory: string
  ): Promise<readonly { absolutePath: string; relativePath: string; mtimeMs: number; size: number }[]> {
    const found: { absolutePath: string; relativePath: string; mtimeMs: number; size: number }[] = [];
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return found;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) {
        continue;
      }
      const skillFile = path.join(directory, entry.name, 'SKILL.md');
      const stats = await this.#statFile(skillFile);
      if (stats === null) {
        continue;
      }
      found.push({
        absolutePath: skillFile,
        relativePath: `${relativeDirectory}/${entry.name}/SKILL.md`,
        mtimeMs: stats.mtimeMs,
        size: stats.size
      });
    }
    return found;
  }

  async #listMarkdownFiles(
    directory: string,
    relativeDirectory: string
  ): Promise<readonly { absolutePath: string; relativePath: string; mtimeMs: number; size: number }[]> {
    const found: { absolutePath: string; relativePath: string; mtimeMs: number; size: number }[] = [];
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return found;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (!entry.isFile() || entry.name.startsWith('.')) {
        continue;
      }
      const stats = await this.#statFile(path.join(directory, entry.name));
      if (stats === null) {
        continue;
      }
      found.push({
        absolutePath: path.join(directory, entry.name),
        relativePath: `${relativeDirectory}/${entry.name}`,
        mtimeMs: stats.mtimeMs,
        size: stats.size
      });
    }
    return found;
  }

  async #readText(relativePath: string): Promise<{ text: string; size: number; mtimeMs: number } | null> {
    const absolutePath = path.resolve(this.#root, relativePath);
    const stats = await this.#statFile(absolutePath);
    if (stats === null) {
      return null;
    }
    const text = await readTextFile(absolutePath);
    if (text === null) {
      return null;
    }
    return { text, size: stats.size, mtimeMs: stats.mtimeMs };
  }

  async #statFile(absolutePath: string): Promise<{ size: number; mtimeMs: number } | null> {
    try {
      const stats = await stat(absolutePath);
      return stats.isFile() ? { size: stats.size, mtimeMs: stats.mtimeMs } : null;
    } catch {
      return null;
    }
  }

  // --- watcher ------------------------------------------------------------

  #ensureWatcher(): void {
    if (this.#watcher !== undefined) {
      return;
    }
    try {
      this.#watcher = watchFs(this.#root, { recursive: true }, (_eventType, filename) => {
        if (!this.#isRelevantChange(filename)) {
          return;
        }
        this.#scheduleReload();
      });
      this.#watcher.on('error', (error: Error) => {
        this.#log(`ContextLoader: watcher упал (${error.message})`);
      });
    } catch (error) {
      this.#log(`ContextLoader: не удалось следить за воркспейсом: ${describeError(error)}`);
    }
  }

  #scheduleReload(): void {
    if (this.#watcherTimer !== undefined) {
      clearTimeout(this.#watcherTimer);
    }
    this.#watcherTimer = setTimeout(() => {
      this.#watcherTimer = undefined;
      void this.#reloadAndNotify();
    }, this.#debounceMs);
  }

  async #reloadAndNotify(): Promise<void> {
    if (this.#disposed) {
      return;
    }
    try {
      this.#cachedPack = undefined;
      this.#cachedFingerprint = undefined;
      const pack = await this.load();
      for (const listener of [...this.#watchListeners]) {
        listener(pack);
      }
    } catch (error) {
      this.#log(`ContextLoader: пересборка контекста упала: ${describeError(error)}`);
    }
  }

  #stopWatcher(): void {
    if (this.#watcherTimer !== undefined) {
      clearTimeout(this.#watcherTimer);
      this.#watcherTimer = undefined;
    }
    if (this.#watcher !== undefined) {
      this.#watcher.close();
      this.#watcher = undefined;
    }
  }
}

// --- помощники --------------------------------------------------------------

/** Файл, изменение которого должно пересобирать контекст. */
export function isRelevantContextFile(filename: string | null): boolean {
  if (filename === null) {
    return true;
  }
  const normalized = filename.replace(/\\/g, '/');
  return (
    /(^|\/)AGENTS\.md$/.test(normalized) ||
    /(^|\/)\.gitignore$/.test(normalized) ||
    /(^|\/)\.dsh\//.test(normalized) ||
    /(^|\/)\.agents\/skills\//.test(normalized)
  );
}

function fingerprintOf(inputs: readonly string[]): string {
  return createHash('sha256').update(inputs.join('\n')).digest('hex').slice(0, 32);
}

function groupByName(skills: readonly SkillDescriptor[]): Map<string, SkillDescriptor[]> {
  const groups = new Map<string, SkillDescriptor[]>();
  for (const skill of skills) {
    const group = groups.get(skill.name) ?? [];
    group.push(skill);
    groups.set(skill.name, group);
  }
  return groups;
}

function firstMeaningfulLine(text: string): string {
  const body = text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
  for (const line of body.split(/\r?\n/)) {
    const trimmed = line.replace(/^#+\s*/, '').trim();
    if (trimmed !== '') {
      return trimmed;
    }
  }
  return '';
}

function splitLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

async function readTextFile(absolutePath: string): Promise<string | null> {
  try {
    return await readFile(absolutePath, 'utf8');
  } catch {
    return null;
  }
}

function toPosix(value: string): string {
  return value.split(path.sep).join('/');
}

function roundMs(value: number): number {
  return Math.round(value * 100) / 100;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function asStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  return value.filter((item): item is string => typeof item === 'string');
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/** Нормализация относительного пути из манифеста: без `./`, но абсолютный путь остаётся абсолютным. */
function normalizeRelativePath(value: string): string {
  let normalized = toPosix(value).trim();
  while (normalized.startsWith('./')) {
    normalized = normalized.slice(2);
  }
  // `docs/../AGENTS.md` должен дедуплицироваться с `AGENTS.md`; границы при
  // этом проверяются отдельно (#isSafeManifestPath), так что `../x` не пройдёт.
  if (normalized !== '' && !path.posix.isAbsolute(normalized)) {
    normalized = path.posix.normalize(normalized).replace(/^\.\/+/, '');
  }
  return normalized;
}

/** Внутри ли путь каталога (защита от `../` и абсолютных путей из манифеста). */
function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/** Обрезка текста по байтам (а не по UTF-16 символам), чтобы уважать maxBytes. */
function truncateToBytes(text: string, maxBytes: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text) <= maxBytes) {
    return { text, truncated: false };
  }
  const buffer = Buffer.from(text);
  let end = Math.max(0, maxBytes);
  // Не разрезаем многобайтный символ: U+FFFD весит 3 байта и вывел бы текст
  // за пределы лимита.
  while (end > 0) {
    const candidate = buffer.subarray(0, end).toString('utf8');
    if (Buffer.byteLength(candidate) <= maxBytes) {
      return { text: candidate, truncated: true };
    }
    end -= 1;
  }
  return { text: '', truncated: true };
}

/**
 * Аудит approval-решений: JSONL в `.dsh/audit.log` с ротацией по размеру.
 *
 * Записи не содержат секретов: аргументы инструмента чистятся рекурсивно
 * (ключи `token`/`secret`/`password`/`apiKey`/…), из строк вычищаются
 * креденшелы URL. Модуль без `vscode`, пишет через `node:fs` (тесты —
 * `tests/approvals-audit.test.mjs`).
 */

import { appendFile, mkdir, rename, stat } from 'node:fs/promises';
import path from 'node:path';

import type { ApprovalDecision, ToolKind } from './approvalPolicy';

/** Откуда взялось решение. */
export type AuditSource = 'policy' | 'user' | 'session' | 'dispose' | 'timeout';

/** Одна запись аудита. */
export interface AuditEntry {
  readonly timestamp: string;
  readonly sessionId: string;
  readonly tool: string;
  readonly kind: ToolKind | string;
  readonly targetPath?: string | undefined;
  readonly decision: ApprovalDecision;
  readonly source: AuditSource;
  readonly reason?: string | null | undefined;
  readonly arguments?: Readonly<Record<string, unknown>> | undefined;
}

/** Настройки журнала. */
export interface AuditLogOptions {
  /** Путь к `.dsh/audit.log`. */
  readonly filePath: string;
  /** Порог ротации в байтах (по умолчанию 1 МБ). */
  readonly maxBytes?: number | undefined;
  /** Сколько архивных файлов хранить (по умолчанию 3). */
  readonly maxFiles?: number | undefined;
  readonly now?: (() => Date) | undefined;
}

const DEFAULT_MAX_BYTES = 1_048_576;
const DEFAULT_MAX_FILES = 3;
const MAX_SANITIZE_DEPTH = 6;

const SECRET_KEY_PATTERN = /(token|secret|passw(or)?d|api[-_]?key|auth|credential|private[-_]?key)/i;

/** Вычищает секреты из произвольного значения перед записью в журнал. */
export function sanitizeForAudit(value: unknown, depth = 0): unknown {
  if (depth > MAX_SANITIZE_DEPTH) {
    return '[too deep]';
  }
  if (typeof value === 'string') {
    // userinfo из URL не пишется; query вырезается только у URL-подобных строк,
    // а в произвольном тексте (например, reason) чистятся лишь секретные
    // query-параметры — обычный «?» не теряет хвост.
    const withoutCredentials = value.replace(/(\/\/)[^/@\s]+@/g, '$1');
    const withoutUrlQuery = withoutCredentials.replace(
      /([a-z][a-z0-9+.-]*:\/\/[^\s?#]*)\?[^\s#]*/gi,
      '$1'
    );
    return withoutUrlQuery.replace(
      /([?&](?:token|access_token|api_key|key|secret)=)[^&\s]+/gi,
      '$1[redacted]'
    );
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeForAudit(item, depth + 1));
  }
  if (typeof value === 'object' && value !== null) {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (SECRET_KEY_PATTERN.test(key)) {
        continue;
      }
      result[key] = sanitizeForAudit(item, depth + 1);
    }
    return result;
  }
  return value;
}

/** Журнал approval-решений. */
export class AuditLog {
  readonly #filePath: string;
  readonly #maxBytes: number;
  readonly #maxFiles: number;
  #queue: Promise<void> = Promise.resolve();

  constructor(options: AuditLogOptions) {
    this.#filePath = options.filePath;
    this.#maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.#maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  }

  /** Путь журнала. */
  get filePath(): string {
    return this.#filePath;
  }

  /** Сериализованно дописывает запись (JSONL) и при необходимости ротирует. */
  record(entry: AuditEntry): Promise<void> {
    const record = this.#normalize(entry);
    this.#queue = this.#queue.then(
      async () => {
        await this.#append(record);
      },
      async () => {
        await this.#append(record);
      }
    );
    return this.#queue;
  }

  #normalize(entry: AuditEntry): Record<string, unknown> {
    const normalized: Record<string, unknown> = {
      timestamp: entry.timestamp,
      sessionId: entry.sessionId,
      tool: entry.tool,
      kind: entry.kind,
      decision: entry.decision,
      source: entry.source
    };
    if (entry.targetPath !== undefined) {
      normalized['targetPath'] = sanitizeForAudit(entry.targetPath);
    }
    if (entry.reason !== undefined && entry.reason !== null) {
      normalized['reason'] = sanitizeForAudit(entry.reason);
    }
    if (entry.arguments !== undefined) {
      normalized['arguments'] = sanitizeForAudit(entry.arguments);
    }
    return normalized;
  }

  async #append(record: Record<string, unknown>): Promise<void> {
    const line = `${JSON.stringify(record)}\n`;
    await mkdir(path.dirname(this.#filePath), { recursive: true, mode: 0o700 });
    await this.#rotateIfNeeded(Buffer.byteLength(line));
    await appendFile(this.#filePath, line, { encoding: 'utf8', mode: 0o600 });
  }

  async #rotateIfNeeded(incomingBytes: number): Promise<void> {
    let currentSize = 0;
    try {
      currentSize = (await stat(this.#filePath)).size;
    } catch {
      return;
    }
    if (currentSize + incomingBytes <= this.#maxBytes) {
      return;
    }

    // audit.log.2 → audit.log.3, … , audit.log → audit.log.1, старый хвост теряем.
    for (let index = this.#maxFiles - 1; index >= 1; index -= 1) {
      try {
        await rename(`${this.#filePath}.${String(index)}`, `${this.#filePath}.${String(index + 1)}`);
      } catch {
        // файла может не быть — это нормально
      }
    }
    try {
      await rename(this.#filePath, `${this.#filePath}.1`);
    } catch {
      // журнала не было
    }
  }
}

/**
 * Сбор диагностики VS Code (#015) с лимитами по количеству/размеру.
 * Модуль без `vscode`; адаптер — `vscodeDiagnostics.ts`, тесты
 * `tests/diagnostics.test.mjs`.
 */

export type DiagnosticSeverityLike = 0 | 1 | 2 | 3 | 'error' | 'warning' | 'information' | 'hint';

export interface DiagnosticLike {
  readonly file: string;
  readonly severity: DiagnosticSeverityLike;
  readonly message: string;
  readonly source?: string | undefined;
  readonly line?: number | undefined;
  readonly column?: number | undefined;
}

export interface DiagnosticsLimits {
  readonly maxItems?: number | undefined;
  readonly maxBytes?: number | undefined;
}

export interface DiagnosticsReport {
  readonly items: readonly DiagnosticLike[];
  readonly total: number;
  readonly truncated: boolean;
  readonly bytes: number;
}

const DEFAULT_MAX_ITEMS = 100;
const DEFAULT_MAX_BYTES = 32 * 1024;

/** Собирает диагностику по открытым файлам, обрезая по лимитам. */
export function collectDiagnostics(
  files: readonly string[],
  getDiagnostics: (file: string) => readonly DiagnosticLike[],
  limits: DiagnosticsLimits = {}
): DiagnosticsReport {
  const maxItems = limits.maxItems ?? DEFAULT_MAX_ITEMS;
  const maxBytes = limits.maxBytes ?? DEFAULT_MAX_BYTES;
  const items: DiagnosticLike[] = [];
  let total = 0;
  let bytes = 0;
  let truncated = false;

  for (const file of files) {
    for (const diagnostic of getDiagnostics(file)) {
      total += 1;
      if (items.length >= maxItems) {
        truncated = true;
        continue;
      }
      const size = Buffer.byteLength(
        `${diagnostic.file}:${String(diagnostic.line ?? 0)}:${diagnostic.message}`,
        'utf8'
      );
      if (bytes + size > maxBytes) {
        truncated = true;
        continue;
      }
      bytes += size;
      items.push(diagnostic);
    }
  }
  return { items, total, truncated, bytes };
}

/** Компактный payload для моста/агента. */
export function diagnosticsPayload(report: DiagnosticsReport): {
  readonly count: number;
  readonly truncated: boolean;
  readonly items: readonly {
    file: string;
    severity: DiagnosticSeverityLike;
    message: string;
    line?: number;
    source?: string;
  }[];
} {
  return {
    count: report.total,
    truncated: report.truncated,
    items: report.items.map((diagnostic) => ({
      file: diagnostic.file,
      severity: diagnostic.severity,
      message: diagnostic.message,
      ...(diagnostic.line === undefined ? {} : { line: diagnostic.line }),
      ...(diagnostic.source === undefined ? {} : { source: diagnostic.source })
    }))
  };
}

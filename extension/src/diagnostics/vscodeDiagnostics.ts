/**
 * VS Code-адаптер диагностики (#015): `languages.getDiagnostics` по открытым
 * документам и отправка отчёта через порт (мост/ACP-рантайм).
 */

import * as vscode from 'vscode';

import {
  collectDiagnostics,
  diagnosticsPayload,
  type DiagnosticLike,
  type DiagnosticsLimits,
  type DiagnosticsReport
} from './collector';

const SEVERITY: Readonly<Record<number, DiagnosticLike['severity']>> = {
  0: 'error',
  1: 'warning',
  2: 'information',
  3: 'hint'
};

/** Диагностика по открытым файлам с лимитами. */
export function collectWorkspaceDiagnostics(limits: DiagnosticsLimits = {}): DiagnosticsReport {
  const files = vscode.workspace.textDocuments
    .filter((document) => !document.isUntitled && document.uri.scheme === 'file')
    .map((document) => document.uri.fsPath);
  return collectDiagnostics(
    files,
    (file) => {
      const uri = vscode.Uri.file(file);
      return vscode.languages.getDiagnostics(uri).map((diagnostic) => ({
        file,
        severity: SEVERITY[diagnostic.severity] ?? 'information',
        message: diagnostic.message,
        ...(diagnostic.source === undefined ? {} : { source: diagnostic.source }),
        line: diagnostic.range.start.line + 1,
        column: diagnostic.range.start.character + 1
      }));
    },
    limits
  );
}

/** Порт отправки отчёта агенту (`diagnostics.report`). */
export interface DiagnosticsReportPort {
  report(payload: ReturnType<typeof diagnosticsPayload>): Promise<void> | void;
}

/** Собирает и отправляет диагностику; ошибки отчёта не роняют расширение. */
export async function reportDiagnostics(
  port: DiagnosticsReportPort,
  limits: DiagnosticsLimits = {}
): Promise<DiagnosticsReport> {
  const report = collectWorkspaceDiagnostics(limits);
  await port.report(diagnosticsPayload(report));
  return report;
}

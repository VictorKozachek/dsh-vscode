/**
 * Политика подтверждений и sandbox-режимы (#009, §8 спецификации).
 *
 * Чистый модуль: по запросу инструмента решает, можно ли выполнять его сразу,
 * нужно ли спросить пользователя или операция запрещена. Тесты —
 * `tests/approvals-policy.test.mjs`.
 *
 * Правила:
 * - запись **вне** воркспейса и сетевые вызовы требуют подтверждения всегда,
 *   даже при политике `auto`;
 * - политика `never` не подтверждает ничего: такие операции запрещаются;
 * - sandbox `read-only` запрещает запись и запуск команд;
 * - `ask` — спрашивать про запись/команды/сеть, чтение разрешать; `auto` —
 *   разрешать всё, что не требует обязательного подтверждения;
 * - политику можно переопределить на конкретный инструмент (`toolPolicies`).
 */

import path from 'node:path';

/** Политика подтверждений (`dsh.approvalPolicy`). */
export type ApprovalPolicy = 'ask' | 'auto' | 'never';

/** Sandbox-режим DSH (`dsh.sandboxMode`). */
export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';

/** Класс операции инструмента. */
export type ToolKind = 'read' | 'write' | 'execute' | 'network';

/** Решение по запросу. */
export type ApprovalDecision = 'allow' | 'allow-session' | 'deny';

/** Что делать с запросом. */
export type ApprovalAction = 'allow' | 'ask' | 'deny';

/** Описание запроса инструмента. */
export interface ApprovalRequestInput {
  readonly id: string;
  readonly tool: string;
  readonly kind: ToolKind;
  /** Путь для write/read — относительно корня воркспейса или абсолютный. */
  readonly targetPath?: string | undefined;
  readonly arguments?: Readonly<Record<string, unknown>> | undefined;
  readonly sessionId: string;
}

/** Настройки проверки. */
export interface ApprovalContext {
  readonly workspaceRoot: string;
  readonly sandboxMode: SandboxMode;
  readonly policy: ApprovalPolicy;
  /** Переопределения политики по имени инструмента. */
  readonly toolPolicies?: Readonly<Record<string, ApprovalPolicy>> | undefined;
}

/** Результат проверки политики. */
export interface ApprovalEvaluation {
  readonly action: ApprovalAction;
  readonly reason: string | null;
  /**
   * Подтверждение обязательно (вне воркспейса, сеть, неизвестный путь):
   * «разрешить для сессии» и `auto` его не снимают.
   */
  readonly mandatory: boolean;
}

/** Значения sandbox-режимов. */
export const SANDBOX_MODES: readonly SandboxMode[] = [
  'read-only',
  'workspace-write',
  'danger-full-access'
];

/** Нормализует настройку sandbox: неизвестное значение → `workspace-write`. */
export function parseSandboxMode(value: string | undefined): SandboxMode {
  return SANDBOX_MODES.includes(value as SandboxMode) ? (value as SandboxMode) : 'workspace-write';
}

/** Аргументы `dsh serve` для выбранного sandbox-режима. */
export function toDshSandboxArguments(mode: SandboxMode): readonly string[] {
  return ['--sandbox', mode];
}

/** Разрешены ли запись и запуск команд в этом режиме. */
export function sandboxAllowsWrites(mode: SandboxMode): boolean {
  return mode !== 'read-only';
}

/**
 * Лежит ли путь внутри воркспейса (после `path.resolve`). Путь может быть
 * относительным — считается от корня воркспейса.
 */
export function isPathInsideWorkspace(targetPath: string, workspaceRoot: string): boolean {
  const root = path.resolve(workspaceRoot);
  const target = path.isAbsolute(targetPath) ? path.resolve(targetPath) : path.resolve(root, targetPath);
  const relativePath = path.relative(root, target);
  return relativePath === '' || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath));
}

/** Проверяет запрос инструмента по политике. */
export function evaluateApproval(
  request: ApprovalRequestInput,
  context: ApprovalContext
): ApprovalEvaluation {
  const effectivePolicy = context.toolPolicies?.[request.tool] ?? context.policy;
  // Запись без пути считается «вне воркспейса»: проверить нечего, доверять нельзя.
  const hasTargetPath = request.targetPath !== undefined && request.targetPath !== '';
  const insideWorkspace = hasTargetPath
    ? isPathInsideWorkspace(request.targetPath ?? '', context.workspaceRoot)
    : false;

  // Sandbox-запрет сильнее политики и обязательных подтверждений: в read-only
  // запись/команда запрещены, и разрешить их через ask нельзя.
  if (
    !sandboxAllowsWrites(context.sandboxMode) &&
    (request.kind === 'write' || request.kind === 'execute')
  ) {
    return {
      action: 'deny',
      reason: `sandbox «${context.sandboxMode}» запрещает ${request.kind}`,
      mandatory: false
    };
  }

  // Обязательные подтверждения: политика `auto` их не снимает.
  const mandatoryReason =
    request.kind === 'network'
      ? 'сетевой вызов'
      : request.kind === 'write' && !insideWorkspace
        ? hasTargetPath
          ? 'запись вне воркспейса'
          : 'запись без указания пути'
        : null;

  if (mandatoryReason !== null) {
    if (effectivePolicy === 'never') {
      return {
        action: 'deny',
        reason: `${mandatoryReason}: политика «never» запрещает подтверждаемые операции`,
        mandatory: true
      };
    }
    return { action: 'ask', reason: mandatoryReason, mandatory: true };
  }

  if (request.kind === 'read') {
    return { action: 'allow', reason: null, mandatory: false };
  }

  switch (effectivePolicy) {
    case 'auto':
      return { action: 'allow', reason: null, mandatory: false };
    case 'ask':
      return { action: 'ask', reason: `политика «ask» для ${request.tool}`, mandatory: false };
    case 'never':
      return { action: 'deny', reason: `политика «never» для ${request.tool}`, mandatory: false };
    default:
      return { action: 'ask', reason: `неизвестная политика для ${request.tool}`, mandatory: false };
  }
}

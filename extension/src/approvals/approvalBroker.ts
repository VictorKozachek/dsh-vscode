/**
 * ApprovalBroker — очередь подтверждений инструментов.
 *
 * Связывает политику (#009, `approvalPolicy.ts`), UI (инлайн-карточка панели
 * или fallback `showInformationMessage`) и аудит (`.dsh/audit.log`). Чистый
 * модуль: оценка политики и UI приходят портами, поэтому поведение
 * («Отклонить» останавливает инструмент, «Разрешить для сессии» запоминается,
 * pending закрывается при dispose) проверяется в Node
 * (`tests/approval-broker.test.mjs`).
 */

import path from 'node:path';

import type {
  ApprovalContext,
  ApprovalDecision,
  ApprovalEvaluation,
  ApprovalRequestInput,
  ToolKind
} from './approvalPolicy';
import type { AuditEntry, AuditSource } from './auditLog';

/** Запрос, который показывается пользователю. */
export interface ApprovalRequestDto {
  readonly id: string;
  readonly tool: string;
  readonly kind: ToolKind;
  readonly targetPath?: string | undefined;
  readonly arguments?: Readonly<Record<string, unknown>> | undefined;
  readonly sessionId: string;
  readonly createdAt: string;
}

/** UI подтверждений (панель или fallback-уведомление). */
export interface ApprovalUiPort {
  /** Спрашивает пользователя; промис может разрешиться и внешним `resolve`. */
  ask(request: ApprovalRequestDto): Promise<ApprovalDecision> | void;
  /** «Показать diff» — отдаём сервису диффов (#010). */
  showDiff?(request: ApprovalRequestDto): void;
}

/** Порт журнала аудита. */
export interface ApprovalAuditPort {
  record(entry: AuditEntry): Promise<void> | void;
}

/** Настройки брокера. */
export interface ApprovalBrokerOptions {
  readonly context: ApprovalContext;
  /** Оценка политики (в проде — `evaluateApproval` из approvalPolicy). */
  readonly evaluate: (
    request: ApprovalRequestInput,
    context: ApprovalContext
  ) => ApprovalEvaluation;
  readonly ui: ApprovalUiPort;
  readonly audit?: ApprovalAuditPort | undefined;
  readonly clock?: (() => Date) | undefined;
  /** Резолв реального пути (symlink) перед проверкой границ. */
  readonly resolveRealPath?: ((absolutePath: string) => Promise<string | null>) | undefined;
  /** Колбэк settled-запроса: панель снимает карточку при решении вне WebView. */
  readonly onResolved?:
    | ((request: ApprovalRequestDto, decision: ApprovalDecision) => void)
    | undefined;
  readonly logger?: ((line: string) => void) | undefined;
}

interface PendingApproval {
  readonly request: ApprovalRequestDto;
  readonly settle: (decision: ApprovalDecision, source: AuditSource, reason?: string) => void;
}

/** Очередь подтверждений: pending, «разрешить для сессии», аудит. */
export class ApprovalBroker {
  readonly #options: ApprovalBrokerOptions;
  readonly #pending = new Map<string, PendingApproval>();
  readonly #sessionAllowed = new Set<string>();
  #disposed = false;

  constructor(options: ApprovalBrokerOptions) {
    this.#options = options;
  }

  /** Запросы, ожидающие решения. */
  get pending(): readonly ApprovalRequestDto[] {
    return [...this.#pending.values()].map((item) => item.request);
  }

  /** Уже разрешён ли инструмент для сессии («Разрешить для этой сессии»). */
  isSessionAllowed(sessionId: string, tool: string): boolean {
    return this.#sessionAllowed.has(sessionKey(sessionId, tool));
  }

  /**
   * Главная точка входа: оценка политики и, если нужно, вопрос пользователю.
   * Возвращает `deny` — вызывающий инструмент **не** выполняет.
   */
  async request(input: ApprovalRequestInput): Promise<ApprovalDecision> {
    if (this.#disposed) {
      return 'deny';
    }

    // Политика и sandbox проверяются ДО «разрешить для сессии»: сессионное
    // разрешение сокращает только обычный ask и не обходит обязательные
    // подтверждения (вне воркспейса, сеть) и запреты (never, read-only).
    const resolved = await this.#withRealTargetPath(input);
    const evaluatedInput = resolved.input;
    const evaluation = this.#options.evaluate(evaluatedInput, {
      ...this.#options.context,
      pathResolved: resolved.pathResolved
    });

    if (evaluation.action === 'allow') {
      await this.#audit(evaluatedInput, 'allow', 'policy', evaluation.reason);
      return 'allow';
    }
    if (evaluation.action === 'deny') {
      await this.#audit(evaluatedInput, 'deny', 'policy', evaluation.reason);
      return 'deny';
    }

    // Сессионное разрешение сокращает только обычный ask: обязательные
    // подтверждения (вне воркспейса, сеть, неизвестный путь) спрашиваются снова.
    if (!evaluation.mandatory && this.isSessionAllowed(input.sessionId, input.tool)) {
      await this.#audit(evaluatedInput, 'allow', 'session', 'разрешено для сессии');
      return 'allow';
    }

    const request = this.#toDto(evaluatedInput);
    const decision = await this.#askUser(request, evaluation.reason);
    return decision;
  }

  /**
   * Резолвит реальный путь (symlink) и проверяет границы.
   *
   * Для ещё не существующего файла `realpath` самого пути даёт `null`, поэтому
   * резолвится ближайший существующий предок, а остаток приклеивается к нему:
   * иначе `link/new.ts` (link → наружу) выглядел бы «внутри root». Если
   * резолвер не подключён, вернул `null` или упал — `pathResolved: false`:
   * политика для write/execute отвечает fail-closed.
   */
  async #withRealTargetPath(
    input: ApprovalRequestInput
  ): Promise<{ input: ApprovalRequestInput; pathResolved: boolean }> {
    if (input.targetPath === undefined) {
      return { input, pathResolved: false };
    }
    const absolutePath = path.isAbsolute(input.targetPath)
      ? input.targetPath
      : path.resolve(this.#options.context.workspaceRoot, input.targetPath);

    if (this.#options.resolveRealPath === undefined) {
      return { input: { ...input, targetPath: absolutePath }, pathResolved: false };
    }

    let candidate = absolutePath;
    const rest: string[] = [];
    for (let depth = 0; depth < 64; depth += 1) {
      const resolved = await this.#options.resolveRealPath(candidate).catch(() => null);
      if (resolved !== null) {
        const full = rest.length === 0 ? resolved : path.join(resolved, ...rest);
        return { input: { ...input, targetPath: full }, pathResolved: true };
      }
      const parent = path.dirname(candidate);
      if (parent === candidate) {
        break;
      }
      rest.unshift(path.basename(candidate));
      candidate = parent;
    }

    return { input: { ...input, targetPath: absolutePath }, pathResolved: false };
  }

  /** Решение из WebView (кнопки инлайн-карточки). Неизвестный id → `false`. */
  resolve(id: string, decision: ApprovalDecision): boolean {
    const pending = this.#pending.get(id);
    if (pending === undefined) {
      return false;
    }
    pending.settle(decision, 'user');
    return true;
  }

  /** «Показать diff» для pending-запроса. */
  showDiff(id: string): boolean {
    const pending = this.#pending.get(id);
    if (pending === undefined) {
      return false;
    }
    this.#options.ui.showDiff?.(pending.request);
    return true;
  }

  /** Закрывает все pending как «отклонено» (панель закрылась, сессия кончилась). */
  dispose(): void {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    for (const [id, pending] of [...this.#pending]) {
      this.#pending.delete(id);
      pending.settle('deny', 'dispose', 'брокер подтверждений закрыт');
    }
  }

  // --- внутреннее ----------------------------------------------------------

  async #askUser(request: ApprovalRequestDto, reason: string | null): Promise<ApprovalDecision> {
    return new Promise<ApprovalDecision>((resolveDecision) => {
      let settled = false;
      const settle = (decision: ApprovalDecision, source: AuditSource, settleReason?: string): void => {
        if (settled) {
          return;
        }
        settled = true;
        this.#pending.delete(request.id);
        if (decision === 'allow-session') {
          this.#sessionAllowed.add(sessionKey(request.sessionId, request.tool));
        }
        void this.#record({
          timestamp: this.#now(),
          sessionId: request.sessionId,
          tool: request.tool,
          kind: request.kind,
          targetPath: request.targetPath,
          arguments: request.arguments,
          decision,
          source,
          reason: settleReason ?? reason
        });
        try {
          this.#options.onResolved?.(request, decision);
        } catch (error) {
          this.#log(`ApprovalBroker: onResolved упал: ${describeError(error)}`);
        }
        resolveDecision(decision);
      };

      this.#pending.set(request.id, { request, settle });

      try {
        const answer = this.#options.ui.ask(request);
        if (answer !== undefined) {
          answer.then(
            (decision) => {
              settle(decision, 'user');
            },
            (error: unknown) => {
              settle('deny', 'user', error instanceof Error ? error.message : 'ошибка UI подтверждения');
            }
          );
        }
      } catch (error) {
        settle('deny', 'user', error instanceof Error ? error.message : String(error));
      }
    });
  }

  #toDto(input: ApprovalRequestInput): ApprovalRequestDto {
    const dto: ApprovalRequestDto = {
      id: input.id,
      tool: input.tool,
      kind: input.kind,
      sessionId: input.sessionId,
      createdAt: this.#now()
    };
    if (input.targetPath !== undefined) {
      (dto as { targetPath?: string }).targetPath = input.targetPath;
    }
    if (input.arguments !== undefined) {
      (dto as { arguments?: Record<string, unknown> }).arguments = { ...input.arguments };
    }
    return dto;
  }

  async #audit(
    input: ApprovalRequestInput,
    decision: ApprovalDecision,
    source: AuditSource,
    reason: string | null
  ): Promise<void> {
    await this.#record({
      timestamp: this.#now(),
      sessionId: input.sessionId,
      tool: input.tool,
      kind: input.kind,
      targetPath: input.targetPath,
      arguments: input.arguments,
      decision,
      source,
      reason
    });
  }

  /** Аудит не должен ломать решение: ошибки записи логируются. */
  async #record(entry: AuditEntry): Promise<void> {
    try {
      await this.#options.audit?.record(entry);
    } catch (error) {
      this.#log(`ApprovalBroker: не удалось записать аудит: ${describeError(error)}`);
    }
  }

  #log(line: string): void {
    this.#options.logger?.(line);
  }

  #now(): string {
    return (this.#options.clock ?? (() => new Date()))().toISOString();
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sessionKey(sessionId: string, tool: string): string {
  return `${sessionId}\u0000${tool}`;
}

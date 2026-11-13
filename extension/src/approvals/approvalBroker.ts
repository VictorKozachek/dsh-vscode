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
    if (this.isSessionAllowed(input.sessionId, input.tool)) {
      await this.#audit(input, 'allow', 'policy', 'разрешено для сессии');
      return 'allow';
    }

    const evaluation = this.#options.evaluate(input, this.#options.context);
    if (evaluation.action === 'allow') {
      await this.#audit(input, 'allow', 'policy', evaluation.reason);
      return 'allow';
    }
    if (evaluation.action === 'deny') {
      await this.#audit(input, 'deny', 'policy', evaluation.reason);
      return 'deny';
    }

    const request = this.#toDto(input);
    const decision = await this.#askUser(request, evaluation.reason);
    return decision;
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
        void this.#options.audit?.record({
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
    await this.#options.audit?.record({
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

  #now(): string {
    return (this.#options.clock ?? (() => new Date()))().toISOString();
  }
}

function sessionKey(sessionId: string, tool: string): string {
  return `${sessionId}\u0000${tool}`;
}

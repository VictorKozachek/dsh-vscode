/**
 * Fallback подтверждений, когда панель DSH скрыта: неблокирующее уведомление
 * `showInformationMessage` с теми же тремя действиями, что и инлайн-карточка.
 *
 * Модуль не импортирует `vscode`: окно передаётся портом (тесты —
 * `tests/approval-broker.test.mjs`).
 */

import type { ApprovalDecision } from './approvalPolicy';
import type { ApprovalRequestDto, ApprovalUiPort } from './approvalBroker';

/** Минимум от `vscode.window`. */
export interface FallbackWindowPort {
  showInformationMessage(message: string, ...items: string[]): PromiseLike<string | undefined>;
}

/** Подписи действий (ru по умолчанию). */
export interface FallbackMessages {
  readonly allow: string;
  readonly allowSession: string;
  readonly deny: string;
  readonly title: (request: ApprovalRequestDto) => string;
}

const RU_MESSAGES: FallbackMessages = {
  allow: 'Разрешить',
  allowSession: 'Разрешить для этой сессии',
  deny: 'Отклонить',
  title: (request) =>
    request.targetPath === undefined
      ? `DSH: разрешить «${request.tool}»?`
      : `DSH: разрешить «${request.tool}» для ${request.targetPath}?`
};

/** UI подтверждений поверх `showInformationMessage`. */
export function createFallbackApprovalUi(
  window: FallbackWindowPort,
  messages: FallbackMessages = RU_MESSAGES
): ApprovalUiPort {
  return {
    async ask(request: ApprovalRequestDto): Promise<ApprovalDecision> {
      const answer = await window.showInformationMessage(
        messages.title(request),
        messages.allow,
        messages.allowSession,
        messages.deny
      );
      if (answer === messages.allow) {
        return 'allow';
      }
      if (answer === messages.allowSession) {
        return 'allow-session';
      }
      // Закрыли уведомление без выбора — безопасный отказ.
      return 'deny';
    }
  };
}

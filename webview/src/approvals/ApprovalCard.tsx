import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent, ReactElement } from 'react';

import type { Translator } from '../i18n';
import {
  approvalActions,
  approvalHasDiff,
  formatApprovalArguments,
  handleApprovalKey
} from './approvalModel';
import type { ApprovalDecisionKind } from './approvalModel';

/** Запрос подтверждения из extension host. */
export interface ApprovalRequestView {
  readonly id: string;
  readonly tool: string;
  readonly kind: 'read' | 'write' | 'execute' | 'network';
  readonly targetPath?: string | undefined;
  readonly arguments?: Readonly<Record<string, unknown>> | undefined;
  readonly sessionId: string;
  readonly createdAt: string;
}

export interface ApprovalCardProps {
  readonly t: Translator;
  readonly request: ApprovalRequestView;
  readonly onDecision: (id: string, decision: ApprovalDecisionKind) => void;
  readonly onShowDiff: (id: string) => void;
}

/**
 * Инлайн-карточка подтверждения: не модальное окно, а блок в ленте.
 * Фокус-ловушка (Tab/Shift+Tab по кругу), Esc — «Отклонить», Enter — действие
 * под фокусом; ARIA-роль `alertdialog` и `aria-modal="false"`.
 */
export function ApprovalCard({
  t,
  request,
  onDecision,
  onShowDiff
}: ApprovalCardProps): ReactElement {
  const hasDiff = approvalHasDiff(request);
  const actions = approvalActions(hasDiff);
  const [focusedIndex, setFocusedIndex] = useState(0);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const buttonRefs = useRef<(HTMLButtonElement | null)[]>([]);

  useEffect(() => {
    buttonRefs.current[0]?.focus();
  }, []);

  const focusIndex = (index: number): void => {
    setFocusedIndex(index);
    buttonRefs.current[index]?.focus();
  };

  const activate = (index: number): void => {
    const action = actions[index];
    if (action === undefined) {
      return;
    }
    if (action.id === 'show-diff') {
      onShowDiff(request.id);
      return;
    }
    onDecision(request.id, action.id);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const result = handleApprovalKey(event.key, focusedIndex, actions, {
      shift: event.shiftKey
    });
    if (result === null) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (result.kind === 'focus') {
      focusIndex(result.index);
      return;
    }
    if (result.kind === 'show-diff') {
      onShowDiff(request.id);
      return;
    }
    onDecision(request.id, result.decision);
  };

  return (
    <div
      ref={containerRef}
      className="dsh-approval"
      role="alertdialog"
      aria-modal="false"
      aria-labelledby={`dsh-approval-title-${request.id}`}
      aria-describedby={`dsh-approval-desc-${request.id}`}
      onKeyDown={handleKeyDown}
    >
      <p className="dsh-approval__title" id={`dsh-approval-title-${request.id}`}>
        {t('approval.title')}: {request.tool}
      </p>
      <p className="dsh-approval__meta" id={`dsh-approval-desc-${request.id}`}>
        {t('approval.kind')}: {request.kind}
        {request.targetPath === undefined ? '' : ` · ${request.targetPath}`}
      </p>
      {request.arguments === undefined ? null : (
        <pre className="dsh-approval__args">{formatApprovalArguments(request.arguments)}</pre>
      )}
      <div className="dsh-approval__actions">
        {actions.map((action, index) => (
          <button
            key={action.id}
            ref={(element) => {
              buttonRefs.current[index] = element;
            }}
            type="button"
            className={`dsh-button${action.primary ? ' dsh-button--primary' : ''}`}
            onClick={() => {
              activate(index);
            }}
            onFocus={() => {
              setFocusedIndex(index);
            }}
          >
            {t(action.labelKey)}
          </button>
        ))}
      </div>
    </div>
  );
}

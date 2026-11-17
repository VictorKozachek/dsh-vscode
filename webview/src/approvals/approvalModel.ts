/**
 * Чистая логика инлайн-карточки подтверждения: набор действий, фокус-ловушка
 * и клавиатурные решения. Модуль без импортов — покрыт тестами в Node
 * (`tests/approval-model.test.mjs`).
 */

/** Решение по запросу (как в extension host). */
export type ApprovalDecisionKind = 'allow' | 'allow-session' | 'deny';

/** Идентификатор действия карточки. */
export type ApprovalActionId = ApprovalDecisionKind | 'show-diff';

/** Описание кнопки. */
export interface ApprovalActionDescriptor {
  readonly id: ApprovalActionId;
  readonly labelKey:
    | 'approval.allow'
    | 'approval.allowSession'
    | 'approval.deny'
    | 'approval.showDiff';
  readonly primary: boolean;
}

/** Действия карточки: три решения и (если есть diff) просмотр изменений. */
export function approvalActions(hasDiff: boolean): readonly ApprovalActionDescriptor[] {
  const actions: ApprovalActionDescriptor[] = [
    { id: 'allow', labelKey: 'approval.allow', primary: true },
    { id: 'allow-session', labelKey: 'approval.allowSession', primary: false },
    { id: 'deny', labelKey: 'approval.deny', primary: false }
  ];
  if (hasDiff) {
    actions.push({ id: 'show-diff', labelKey: 'approval.showDiff', primary: false });
  }
  return actions;
}

/** Следующий индекс фокуса по кругу (Tab/Shift+Tab, стрелки). */
export function nextFocusIndex(current: number, length: number, step: 1 | -1): number {
  if (length <= 0) {
    return 0;
  }
  return (current + step + length) % length;
}

/** Результат нажатия клавиши в карточке. */
export type ApprovalKeyResult =
  | { readonly kind: 'decision'; readonly decision: ApprovalDecisionKind }
  | { readonly kind: 'show-diff' }
  | { readonly kind: 'focus'; readonly index: number }
  | null;

/**
 * Клавиатура карточки: Esc — отклонить, стрелки/Tab — фокус по кругу,
 * Enter — действие под фокусом.
 */
export function handleApprovalKey(
  key: string,
  focusedIndex: number,
  actions: readonly ApprovalActionDescriptor[],
  options: { readonly shift?: boolean } = {}
): ApprovalKeyResult {
  if (key === 'Escape') {
    return { kind: 'decision', decision: 'deny' };
  }
  if (key === 'ArrowRight' || key === 'ArrowDown') {
    return { kind: 'focus', index: nextFocusIndex(focusedIndex, actions.length, 1) };
  }
  if (key === 'ArrowLeft' || key === 'ArrowUp') {
    return { kind: 'focus', index: nextFocusIndex(focusedIndex, actions.length, -1) };
  }
  if (key === 'Tab') {
    return {
      kind: 'focus',
      index: nextFocusIndex(focusedIndex, actions.length, options.shift === true ? -1 : 1)
    };
  }
  if (key === 'Enter' || key === ' ') {
    const action = actions[focusedIndex];
    if (action === undefined) {
      return null;
    }
    if (action.id === 'show-diff') {
      return { kind: 'show-diff' };
    }
    return { kind: 'decision', decision: action.id };
  }
  return null;
}

/** Аргументы инструмента для предпросмотра в карточке (текст, не HTML). */
export function formatApprovalArguments(
  args: Readonly<Record<string, unknown>> | undefined,
  maxLength = 2000
): string {
  if (args === undefined) {
    return '';
  }
  let text: string;
  try {
    text = JSON.stringify(args, null, 2);
  } catch {
    text = '[unserializable]';
  }
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

/** Есть ли у запроса diff для кнопки «Показать diff». */
export function approvalHasDiff(request: {
  readonly kind: string;
  readonly targetPath?: string | undefined;
}): boolean {
  return request.kind === 'write' && typeof request.targetPath === 'string' && request.targetPath !== '';
}

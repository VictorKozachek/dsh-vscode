/**
 * Клиентская модель формы New Session (#023): значения, валидация (зеркало
 * extension-модели для мгновенных ошибок), поиск моделей, клавиатура и
 * фокус-ловушка. Без React — тесты `tests/new-session-webview.test.mjs`.
 */

import type {
  NewSessionFormDto,
  NewSessionValuesDto
} from '../messages';

/** Sandbox-режимы. */
export const SANDBOX_OPTIONS = ['read-only', 'workspace-write', 'danger-full-access'] as const;
export type SandboxChoice = (typeof SANDBOX_OPTIONS)[number];

/** Политики подтверждений. */
export const APPROVAL_OPTIONS = ['ask', 'auto', 'never'] as const;
export type ApprovalChoice = (typeof APPROVAL_OPTIONS)[number];

/** Ошибки формы. */
export type FormErrors = Partial<Record<keyof NewSessionValuesDto | 'form', string>>;

/** Значения формы по умолчанию из wire-формы. */
export function initialValues(form: NewSessionFormDto): NewSessionValuesDto {
  return { ...form.values, title: form.values.title ?? '', confirmDanger: form.values.confirmDanger };
}

/** Валидация для мгновенной подсветки. */
export function validateForm(
  values: NewSessionValuesDto,
  form: NewSessionFormDto
): FormErrors {
  const errors: FormErrors = {};
  if (values.preset.trim() === '') {
    errors.preset = 'newSession.error.presetRequired';
  } else if (!form.presets.some((preset) => preset.id === values.preset)) {
    errors.preset = 'newSession.error.presetUnknown';
  }
  if (values.model.trim() === '') {
    errors.model = 'newSession.error.modelRequired';
  } else if (form.models.length > 0 && !form.models.includes(values.model.trim())) {
    errors.model = 'newSession.error.modelUnknown';
  }
  if (!SANDBOX_OPTIONS.includes(values.sandbox)) {
    errors.sandbox = 'newSession.error.sandboxUnknown';
  } else if (values.sandbox === 'danger-full-access' && !values.confirmDanger) {
    errors.sandbox = 'newSession.error.dangerConfirm';
  }
  if (!APPROVAL_OPTIONS.includes(values.approval)) {
    errors.approval = 'newSession.error.approvalUnknown';
  }
  if (values.title.length > 120) {
    errors.title = 'newSession.error.titleTooLong';
  }
  return errors;
}

/**
 * Поиск моделей по подстроке (регистронезависимый). Выбранная модель всегда
 * остаётся в списке, даже если не совпала с запросом.
 */
export function filterModels(
  models: readonly string[],
  query: string,
  selected?: string | undefined
): readonly string[] {
  const needle = query.trim().toLowerCase();
  const filtered =
    needle === '' ? [...models] : models.filter((model) => model.toLowerCase().includes(needle));
  if (selected !== undefined && selected !== '' && !filtered.includes(selected)) {
    filtered.unshift(selected);
  }
  return filtered;
}

/** Следующий индекс фокуса по кругу. */
export function nextFocusIndex(current: number, length: number, step: 1 | -1): number {
  if (length <= 0) {
    return 0;
  }
  return (current + step + length) % length;
}

/** Действия формы для клавиатуры. */
export type FormAction = 'cancel' | 'submit';

/** Esc — отмена, Ctrl/Cmd+Enter — создание. */
export function handleFormKey(
  key: string,
  options: { readonly ctrlKey?: boolean; readonly metaKey?: boolean } = {}
): FormAction | null {
  if (key === 'Escape') {
    return 'cancel';
  }
  if (key === 'Enter' && (options.ctrlKey === true || options.metaKey === true)) {
    return 'submit';
  }
  return null;
}

/** Доступен ли пресет, выбранный в значениях. */
export function presetById(
  form: NewSessionFormDto,
  presetId: string
): NewSessionFormDto['presets'][number] | undefined {
  return form.presets.find((preset) => preset.id === presetId);
}

/** Описание выбранного пресета (для подписи рядом с селектом). */
export function presetDescription(form: NewSessionFormDto, presetId: string): string {
  return presetById(form, presetId)?.description ?? 'newSession.presetFallback';
}

/** Ключ i18n с предупреждением для danger-full-access. */
export const DANGER_WARNING = 'newSession.dangerWarning';

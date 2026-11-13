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
    errors.preset = 'Выберите пресет';
  } else if (!form.presets.some((preset) => preset.id === values.preset)) {
    errors.preset = 'Пресет недоступен';
  }
  if (values.model.trim() === '') {
    errors.model = 'Выберите модель';
  } else if (form.models.length > 0 && !form.models.includes(values.model.trim())) {
    errors.model = 'Модель недоступна';
  }
  if (values.sandbox === 'danger-full-access' && !values.confirmDanger) {
    errors.sandbox = 'danger-full-access требует подтверждения';
  }
  if (values.title.length > 120) {
    errors.title = 'Слишком длинный заголовок';
  }
  return errors;
}

/** Поиск моделей по подстроке (регистронезависимый). */
export function filterModels(models: readonly string[], query: string): readonly string[] {
  const needle = query.trim().toLowerCase();
  if (needle === '') {
    return models;
  }
  return models.filter((model) => model.toLowerCase().includes(needle));
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
  return presetById(form, presetId)?.description ?? 'Пресет рантайма DSH';
}

/** Предупреждение для danger-full-access. */
export const DANGER_WARNING =
  'danger-full-access снимает ограничения sandbox: агент сможет писать в любые файлы и запускать команды без ограничений воркспейса.';

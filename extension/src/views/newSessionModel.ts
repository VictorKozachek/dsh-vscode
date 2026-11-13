/**
 * Модель диалога «New Session» (#023): пресет, модель, sandbox, approval,
 * заголовок; значения по умолчанию, валидация, генерация имени, запоминание.
 *
 * Модуль без `vscode` и без состояния — тесты
 * `tests/new-session-model.test.mjs`. Sandbox/approval здесь локальные
 * объединения: #009 (политики) в этой ветке ещё не слит; при проводке #011
 * значения сверяются с `approvalPolicy.ts`.
 */

/** Пресет рантайма. */
export interface PresetOption {
  readonly id: string;
  readonly title: string;
  readonly description?: string | undefined;
}

/** Значения формы. */
export interface NewSessionValues {
  readonly preset: string;
  readonly model: string;
  readonly sandbox: SandboxChoice;
  readonly approval: ApprovalChoice;
  readonly title: string;
  /** Для `danger-full-access` нужно явное подтверждение. */
  readonly confirmDanger: boolean;
}

/** Sandbox-режим (`dsh.sandboxMode`). */
export const SANDBOX_OPTIONS = ['read-only', 'workspace-write', 'danger-full-access'] as const;
export type SandboxChoice = (typeof SANDBOX_OPTIONS)[number];

/** Политика подтверждений (`dsh.approvalPolicy`). */
export const APPROVAL_OPTIONS = ['ask', 'auto', 'never'] as const;
export type ApprovalChoice = (typeof APPROVAL_OPTIONS)[number];

/** Сохранённые настройки расширения. */
export interface NewSessionSettings {
  readonly defaultModel?: string | undefined;
  readonly sandboxMode?: string | undefined;
  readonly approvalPolicy?: string | undefined;
}

/** Последние использованные значения. */
export interface RememberedNewSession {
  readonly preset?: string | undefined;
  readonly model?: string | undefined;
  readonly sandbox?: string | undefined;
  readonly approval?: string | undefined;
}

/** Ошибки формы по полям + общая. */
export type NewSessionErrors = Partial<Record<keyof NewSessionValues | 'form', string>>;

/** Данные для открытия формы в webview. */
export interface NewSessionForm {
  readonly presets: readonly PresetOption[];
  readonly models: readonly string[];
  readonly values: NewSessionValues;
  readonly errors: NewSessionErrors;
}

/** Пресет, который доступен всегда. */
export const STANDARD_PRESET: PresetOption = {
  id: 'standard',
  title: 'standard',
  description: 'Базовый пресет DSH'
};

/** Предел длины заголовка. */
export const MAX_TITLE_LENGTH = 120;

/** Нормализует sandbox: неизвестное значение → `workspace-write`. */
export function coerceSandbox(value: string | undefined): SandboxChoice {
  return (SANDBOX_OPTIONS as readonly string[]).includes(value ?? '')
    ? (value as SandboxChoice)
    : 'workspace-write';
}

/** Нормализует approval: неизвестное значение → `ask`. */
export function coerceApproval(value: string | undefined): ApprovalChoice {
  return (APPROVAL_OPTIONS as readonly string[]).includes(value ?? '')
    ? (value as ApprovalChoice)
    : 'ask';
}

/** Список пресетов: `standard` всегда есть и идёт первым; дубли убираются. */
export function mergePresets(presets: readonly PresetOption[]): readonly PresetOption[] {
  const seen = new Set<string>();
  const result: PresetOption[] = [STANDARD_PRESET];
  seen.add(STANDARD_PRESET.id);
  for (const preset of presets) {
    if (preset.id === '' || seen.has(preset.id)) {
      continue;
    }
    seen.add(preset.id);
    result.push(preset);
  }
  return result;
}

/** Список моделей: дефолтная всегда доступна и первая; пустые убираются. */
export function mergeModels(
  models: readonly string[],
  defaultModel: string | undefined
): readonly string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  const preferred = defaultModel?.trim();
  if (preferred !== undefined && preferred !== '') {
    seen.add(preferred);
    result.push(preferred);
  }
  for (const model of models) {
    const trimmed = model.trim();
    if (trimmed === '' || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}

/** Значения по умолчанию: настройки, затем последние использованные. */
export function buildNewSessionValues(input: {
  readonly settings: NewSessionSettings;
  readonly remembered: RememberedNewSession;
}): NewSessionValues {
  const model = input.remembered.model?.trim() || input.settings.defaultModel?.trim() || 'deepseek-chat';
  return {
    preset: (input.remembered.preset?.trim() || STANDARD_PRESET.id) as string,
    model,
    sandbox: coerceSandbox(input.remembered.sandbox ?? input.settings.sandboxMode),
    approval: coerceApproval(input.remembered.approval ?? input.settings.approvalPolicy),
    title: '',
    confirmDanger: false
  };
}

/** Проверка формы; возвращает ошибки по полям (пусто — форма валидна). */
export function validateNewSession(
  values: NewSessionValues,
  options: { readonly presets: readonly PresetOption[]; readonly models: readonly string[] }
): NewSessionErrors {
  const errors: NewSessionErrors = {};
  if (values.preset.trim() === '') {
    errors.preset = 'Выберите пресет';
  } else if (!options.presets.some((preset) => preset.id === values.preset)) {
    errors.preset = `Неизвестный пресет: ${values.preset}`;
  }
  if (values.model.trim() === '') {
    errors.model = 'Выберите модель';
  } else if (
    options.models.length > 0 &&
    !options.models.includes(values.model.trim())
  ) {
    errors.model = `Модель недоступна: ${values.model}`;
  }
  if (!SANDBOX_OPTIONS.includes(values.sandbox)) {
    errors.sandbox = 'Неизвестный sandbox-режим';
  } else if (values.sandbox === 'danger-full-access' && !values.confirmDanger) {
    errors.sandbox = 'danger-full-access требует явного подтверждения';
  }
  if (!APPROVAL_OPTIONS.includes(values.approval)) {
    errors.approval = 'Неизвестная политика подтверждений';
  }
  if (values.title.trim().length > MAX_TITLE_LENGTH) {
    errors.title = `Заголовок длиннее ${String(MAX_TITLE_LENGTH)} символов`;
  }
  return errors;
}

/** Есть ли ошибки. */
export function hasErrors(errors: NewSessionErrors): boolean {
  return Object.keys(errors).length > 0;
}

/** Заголовок: введённый или сгенерированный из пресета и времени. */
export function defaultSessionTitle(values: NewSessionValues, now: Date): string {
  const title = values.title.trim();
  if (title !== '') {
    return title;
  }
  const pad = (value: number): string => String(value).padStart(2, '0');
  const stamp = `${pad(now.getDate())}.${pad(now.getMonth() + 1)} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
  return `${values.preset} · ${stamp}`;
}

/** Что уходит в рантайм. */
export interface NewSessionCreateOptions {
  readonly preset: string;
  readonly model: string;
  readonly sandbox: SandboxChoice;
  readonly approval: ApprovalChoice;
  readonly title: string;
}

/** Параметры создания из валидной формы. */
export function buildCreateOptions(values: NewSessionValues, now: Date): NewSessionCreateOptions {
  return {
    preset: values.preset.trim(),
    model: values.model.trim(),
    sandbox: values.sandbox,
    approval: values.approval,
    title: defaultSessionTitle(values, now)
  };
}

/** Значения для запоминания. */
export function rememberedFromValues(values: NewSessionValues): RememberedNewSession {
  return {
    preset: values.preset,
    model: values.model,
    sandbox: values.sandbox,
    approval: values.approval
  };
}

/** Ключ `workspaceState`/`globalState` для последних значений. */
export const REMEMBERED_KEY = 'dsh.newSession.last';

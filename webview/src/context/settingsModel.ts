/**
 * Настройки `dsh.*` для экрана настроек (#013): определения, подсказки и
 * валидация. Чистый модуль — тесты `tests/settings-model.test.mjs`.
 */

export type SettingType = 'string' | 'number' | 'boolean' | 'array';

export interface SettingDefinition {
  readonly key: string;
  readonly label: string;
  readonly type: SettingType;
  readonly values?: readonly string[];
  readonly default: unknown;
  readonly hint: string;
}

export const SETTINGS: readonly SettingDefinition[] = [
  {
    key: 'executablePath',
    label: 'dsh.executablePath',
    type: 'string',
    default: 'dsh',
    hint: 'Путь к бинарю dsh (на remote — путь на хосте).'
  },
  {
    key: 'profile',
    label: 'dsh.profile',
    type: 'string',
    default: 'acp',
    hint: 'Профиль DSH; для расширения — acp.'
  },
  {
    key: 'defaultModel',
    label: 'dsh.defaultModel',
    type: 'string',
    default: 'deepseek-chat',
    hint: 'Модель по умолчанию для новых сессий.'
  },
  {
    key: 'models',
    label: 'dsh.models',
    type: 'array',
    default: [],
    hint: 'Дополнительные модели (через запятую).'
  },
  {
    key: 'sandboxMode',
    label: 'dsh.sandboxMode',
    type: 'string',
    values: ['read-only', 'workspace-write', 'danger-full-access'],
    default: 'workspace-write',
    hint: 'danger-full-access снимает ограничения песочницы.'
  },
  {
    key: 'approvalPolicy',
    label: 'dsh.approvalPolicy',
    type: 'string',
    values: ['ask', 'auto', 'never'],
    default: 'ask',
    hint: 'ask — спрашивать перед инструментами.'
  },
  {
    key: 'workspace.graceMinutes',
    label: 'dsh.workspace.graceMinutes',
    type: 'number',
    default: 10,
    hint: 'Сколько минут держать процесс старого воркспейса.'
  },
  {
    key: 'context.maxBytes',
    label: 'dsh.context.maxBytes',
    type: 'number',
    default: 262144,
    hint: 'Лимит размера индекса контекста.'
  },
  {
    key: 'primaryWorkspace',
    label: 'dsh.primaryWorkspace',
    type: 'string',
    default: '',
    hint: 'Имя primary-папки multi-root (пусто — первая по index).'
  }
];

export interface SettingsValidation {
  readonly values: Readonly<Record<string, unknown>>;
  readonly errors: Readonly<Record<string, string>>;
  readonly valid: boolean;
}

/** Валидирует значения формы; ошибки — по ключу настройки. */
export function validateSettings(input: Readonly<Record<string, unknown>>): SettingsValidation {
  const values: Record<string, unknown> = {};
  const errors: Record<string, string> = {};
  for (const setting of SETTINGS) {
    const raw = input[setting.key];
    if (raw === undefined || raw === null || raw === '') {
      values[setting.key] = setting.default;
      continue;
    }
    switch (setting.type) {
      case 'boolean':
        if (typeof raw !== 'boolean') {
          errors[setting.key] = 'ожидается true/false';
        } else {
          values[setting.key] = raw;
        }
        break;
      case 'number': {
        const number = typeof raw === 'number' ? raw : Number(raw);
        if (!Number.isFinite(number) || number < 0) {
          errors[setting.key] = 'ожидается неотрицательное число';
        } else {
          values[setting.key] = number;
        }
        break;
      }
      case 'array': {
        if (!Array.isArray(raw) && typeof raw !== 'string') {
          errors[setting.key] = 'ожидается список строк';
          break;
        }
        const list = Array.isArray(raw)
          ? raw
          : String(raw)
              .split(',')
              .map((item) => item.trim())
              .filter((item) => item !== '');
        if (!list.every((item) => typeof item === 'string')) {
          errors[setting.key] = 'ожидается список строк';
        } else {
          values[setting.key] = list;
        }
        break;
      }
      default: {
        const text = String(raw);
        if (setting.values !== undefined && !setting.values.includes(text)) {
          errors[setting.key] = `допустимо: ${setting.values.join(', ')}`;
        } else {
          values[setting.key] = text;
        }
      }
    }
  }
  return { values, errors, valid: Object.keys(errors).length === 0 };
}

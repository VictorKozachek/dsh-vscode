import type { ReactElement } from 'react';
import { useMemo, useState } from 'react';

import { SETTINGS, validateSettings } from './settingsModel';

/** Экран настроек dsh.* с валидацией и подсказками (#013). */
export function SettingsScreen({
  initial,
  onApply
}: {
  readonly initial: Readonly<Record<string, unknown>>;
  readonly onApply: (values: Readonly<Record<string, unknown>>) => void;
}): ReactElement {
  const [values, setValues] = useState<Record<string, unknown>>({ ...initial });
  const validation = useMemo(() => validateSettings(values), [values]);

  return (
    <form
      className="dsh-settings"
      onSubmit={(event) => {
        event.preventDefault();
        if (validation.valid) {
          onApply(validation.values);
        }
      }}
    >
      {SETTINGS.map((setting) => (
        <label key={setting.key} className="dsh-field">
          <span>{setting.label}</span>
          {setting.values === undefined ? (
            <input
              type={setting.type === 'number' ? 'number' : 'text'}
              value={String(values[setting.key] ?? '')}
              onChange={(event) =>
                setValues((previous) => ({ ...previous, [setting.key]: event.target.value }))
              }
            />
          ) : (
            <select
              value={String(values[setting.key] ?? setting.default)}
              onChange={(event) =>
                setValues((previous) => ({ ...previous, [setting.key]: event.target.value }))
              }
            >
              {setting.values.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          )}
          <small className="dsh-field__hint">{setting.hint}</small>
          {validation.errors[setting.key] === undefined ? null : (
            <span className="dsh-field__error" role="alert">
              {validation.errors[setting.key]}
            </span>
          )}
        </label>
      ))}
      <button type="submit" className="dsh-button" disabled={!validation.valid}>
        Применить
      </button>
    </form>
  );
}

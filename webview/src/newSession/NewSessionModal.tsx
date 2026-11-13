import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent, ReactElement } from 'react';

import type { Translator } from '../i18n';
import type { NewSessionFormDto, NewSessionValuesDto } from '../messages';
import {
  APPROVAL_OPTIONS,
  DANGER_WARNING,
  SANDBOX_OPTIONS,
  filterModels,
  handleFormKey,
  initialValues,
  presetDescription,
  validateForm
} from './newSessionModel';
import type { FormErrors } from './newSessionModel';

export interface NewSessionModalProps {
  readonly t: Translator;
  readonly form: NewSessionFormDto;
  readonly onSubmit: (values: NewSessionValuesDto) => void;
  readonly onCancel: () => void;
}

/**
 * Модальная форма создания сессии: пресет, модель с поиском, sandbox,
 * approval, заголовок. Фокус-ловушка (Tab/Shift+Tab внутри формы), Esc —
 * отмена, Ctrl/Cmd+Enter — создание.
 */
export function NewSessionModal({
  t,
  form,
  onSubmit,
  onCancel
}: NewSessionModalProps): ReactElement {
  const [values, setValues] = useState<NewSessionValuesDto>(() => initialValues(form));
  const [modelQuery, setModelQuery] = useState('');
  const [localErrors, setLocalErrors] = useState<FormErrors>({});
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setValues(initialValues(form));
    setLocalErrors(form.errors as FormErrors);
  }, [form]);

  useEffect(() => {
    containerRef.current?.querySelector<HTMLElement>('select, input, button')?.focus();
  }, []);

  const errors: FormErrors = { ...localErrors, ...(form.errors as FormErrors) };
  const models = filterModels(form.models, modelQuery, values.model);

  const change = (patch: Partial<NewSessionValuesDto>): void => {
    setValues((previous) => {
      const next = { ...previous, ...patch };
      setLocalErrors(validateForm(next, form));
      return next;
    });
  };

  const submit = (): void => {
    const found = validateForm(values, form);
    setLocalErrors(found);
    if (Object.keys(found).length === 0) {
      onSubmit(values);
    }
  };

  const trapFocus = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'Tab') {
      return;
    }
    const focusable = [
      ...(event.currentTarget.querySelectorAll<HTMLElement>('input, select, textarea, button'))
    ].filter((element) => !element.hasAttribute('disabled'));
    if (focusable.length === 0) {
      return;
    }
    const index = focusable.indexOf(document.activeElement as HTMLElement);
    const next = (index + (event.shiftKey ? -1 : 1) + focusable.length) % focusable.length;
    const target = focusable[next];
    if (target !== undefined) {
      event.preventDefault();
      target.focus();
    }
  };

  const handleKey = (event: KeyboardEvent<HTMLDivElement>): void => {
    const action = handleFormKey(event.key, { ctrlKey: event.ctrlKey, metaKey: event.metaKey });
    if (action === 'cancel') {
      event.preventDefault();
      onCancel();
      return;
    }
    if (action === 'submit') {
      event.preventDefault();
      submit();
      return;
    }
    trapFocus(event);
  };

  return (
    <div className="dsh-modal-backdrop" role="presentation">
      <div
        ref={containerRef}
        className="dsh-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="dsh-new-session-title"
        onKeyDown={handleKey}
      >
        <h2 className="dsh-modal__title" id="dsh-new-session-title">
          {t('newSession.title')}
        </h2>

        <label className="dsh-field">
          <span>{t('newSession.preset')}</span>
          <select
            value={values.preset}
            onChange={(event) => {
              change({ preset: event.target.value });
            }}
          >
            {form.presets.map((preset) => (
              <option key={preset.id} value={preset.id}>
                {preset.title}
              </option>
            ))}
          </select>
          <small className="dsh-field__hint">{t(presetDescription(form, values.preset))}</small>
          {errors.preset === undefined ? null : (
            <span className="dsh-field__error">{t(errors.preset)}</span>
          )}
        </label>

        <label className="dsh-field">
          <span>{t('newSession.model')}</span>
          <input
            type="search"
            value={modelQuery}
            placeholder={t('newSession.modelSearch')}
            onChange={(event) => {
              setModelQuery(event.target.value);
            }}
          />
          <select
            value={values.model}
            onChange={(event) => {
              change({ model: event.target.value });
            }}
          >
            {models.map((model) => (
              <option key={model} value={model}>
                {model}
              </option>
            ))}
          </select>
          {errors.model === undefined ? null : (
            <span className="dsh-field__error">{t(errors.model)}</span>
          )}
        </label>

        <fieldset className="dsh-field">
          <legend>{t('newSession.sandbox')}</legend>
          {SANDBOX_OPTIONS.map((sandbox) => (
            <label key={sandbox} className="dsh-radio">
              <input
                type="radio"
                name="sandbox"
                value={sandbox}
                checked={values.sandbox === sandbox}
                onChange={() => {
                  change({ sandbox, confirmDanger: sandbox === 'danger-full-access' ? values.confirmDanger : false });
                }}
              />
              {sandbox}
            </label>
          ))}
          {values.sandbox === 'danger-full-access' ? (
            <>
              <p className="dsh-warning">{t(DANGER_WARNING)}</p>
              <label className="dsh-checkbox">
                <input
                  type="checkbox"
                  checked={values.confirmDanger}
                  onChange={(event) => {
                    change({ confirmDanger: event.target.checked });
                  }}
                />
                {t('newSession.dangerConfirm')}
              </label>
            </>
          ) : null}
          {errors.sandbox === undefined ? null : (
            <span className="dsh-field__error">{t(errors.sandbox)}</span>
          )}
        </fieldset>

        <label className="dsh-field">
          <span>{t('newSession.approval')}</span>
          <select
            value={values.approval}
            onChange={(event) => {
              change({ approval: event.target.value as NewSessionValuesDto['approval'] });
            }}
          >
            {APPROVAL_OPTIONS.map((approval) => (
              <option key={approval} value={approval}>
                {approval}
              </option>
            ))}
          </select>
          {errors.approval === undefined ? null : (
            <span className="dsh-field__error">{t(errors.approval)}</span>
          )}
        </label>

        <label className="dsh-field">
          <span>{t('newSession.titleField')}</span>
          <input
            type="text"
            value={values.title}
            placeholder={t('newSession.titlePlaceholder')}
            onChange={(event) => {
              change({ title: event.target.value });
            }}
          />
          {errors.title === undefined ? null : (
            <span className="dsh-field__error">{t(errors.title)}</span>
          )}
        </label>

        {errors.form === undefined ? null : (
          <p className="dsh-field__error" role="alert">
            {t(errors.form)}
          </p>
        )}

        <div className="dsh-modal__actions">
          <button type="button" className="dsh-button" onClick={onCancel}>
            {t('newSession.cancel')}
          </button>
          <button type="button" className="dsh-button dsh-button--primary" onClick={submit}>
            {t('newSession.create')}
          </button>
        </div>
      </div>
    </div>
  );
}

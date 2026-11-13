import type { KeyboardEvent, ReactElement } from 'react';

import type { Translator } from '../i18n';

export interface ComposerProps {
  readonly t: Translator;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly onSubmit: () => void;
  /** Без активной сессии composer заблокирован (#024). */
  readonly disabled?: boolean | undefined;
  readonly onCreateSession?: (() => void) | undefined;
}

/** Composer: многострочный ввод, Enter — отправить, Shift+Enter — новая строка. */
export function Composer({
  t,
  value,
  onChange,
  onSubmit,
  disabled = false,
  onCreateSession
}: ComposerProps): ReactElement {
  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      onSubmit();
    }
  };

  return (
    <form
      className="dsh-composer"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <label className="dsh-visually-hidden" htmlFor="dsh-composer-input">
        {t('composer.label')}
      </label>
      <textarea
        id="dsh-composer-input"
        className="dsh-composer__input"
        rows={3}
        value={value}
        placeholder={t('composer.placeholder')}
        onChange={(event) => {
          onChange(event.target.value);
        }}
        onKeyDown={handleKeyDown}
        aria-describedby="dsh-composer-hint"
        disabled={disabled}
      />
      <p id="dsh-composer-hint" className="dsh-composer__hint">
        {t('composer.hint')}
      </p>
      {disabled ? (
        <button
          type="button"
          className="dsh-button dsh-button--primary"
          onClick={onCreateSession}
        >
          {t('composer.createSession')}
        </button>
      ) : (
        <button
          type="submit"
          className="dsh-button dsh-button--primary"
          disabled={value.trim() === ''}
          aria-label={t('composer.send')}
        >
          {t('composer.send')}
        </button>
      )}
    </form>
  );
}

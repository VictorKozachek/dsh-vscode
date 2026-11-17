import type { ReactElement } from 'react';

import type { ChatPanelStatus } from '../messages';
import type { Translator } from '../i18n';

export interface HeaderProps {
  readonly t: Translator;
  readonly workspaceName: string;
  readonly model: string;
  readonly sandboxMode: string;
  readonly status: ChatPanelStatus;
  readonly onStop: () => void;
  /** Имя активной сессии (#024). */
  readonly sessionTitle?: string | null | undefined;
  /** Статус сессии из рантайма. */
  readonly sessionStatus?: string | undefined;
  /** Модель и пресет активной сессии (#024). */
  readonly sessionModel?: string | undefined;
  readonly sessionPreset?: string | undefined;
}

/** Шапка панели: имя воркспейса, модель, sandbox, кнопка «Стоп». */
export function Header({
  t,
  workspaceName,
  model,
  sandboxMode,
  status,
  onStop,
  sessionTitle,
  sessionStatus,
  sessionModel,
  sessionPreset
}: HeaderProps): ReactElement {
  return (
    <header className="dsh-header">
      <div className="dsh-header__row">
        <h1 className="dsh-header__title">{t('panel.title')}</h1>
        <button
          type="button"
          className="dsh-button dsh-button--stop"
          onClick={onStop}
          disabled={status !== 'thinking'}
          aria-label={t('header.stop')}
          title={t('header.stop')}
        >
          {t('header.stop')}
        </button>
      </div>
      <dl className="dsh-header__meta">
        <div className="dsh-header__meta-item">
          <dt>{t('header.session')}</dt>
          <dd title={sessionTitle ?? undefined}>
            {sessionTitle ?? t('header.noSession')}
            {sessionStatus === undefined ? '' : ` · ${sessionStatus}`}
            {sessionPreset === undefined || sessionPreset === '' ? '' : ` · ${sessionPreset}`}
            {sessionModel === undefined || sessionModel === '' ? '' : ` · ${sessionModel}`}
          </dd>
        </div>
        <div className="dsh-header__meta-item">
          <dt>{t('header.workspace')}</dt>
          <dd title={workspaceName}>{workspaceName}</dd>
        </div>
        <div className="dsh-header__meta-item">
          <dt>{t('header.model')}</dt>
          <dd>{model}</dd>
        </div>
        <div className="dsh-header__meta-item">
          <dt>{t('header.sandbox')}</dt>
          <dd>{sandboxMode}</dd>
        </div>
      </dl>
    </header>
  );
}

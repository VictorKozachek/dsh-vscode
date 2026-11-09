import type { ReactElement } from 'react';

import type { Translator } from '../i18n';
import type { ChatPanelStatus } from '../messages';

export interface PanelStatusProps {
  readonly t: Translator;
  readonly status: ChatPanelStatus;
}

const STATUS_KEY = {
  idle: 'status.idle',
  thinking: 'status.thinking',
  stopped: 'status.stopped'
} as const;

/** Статус-строка панели: состояние, токены, длительность (каркас). */
export function PanelStatus({ t, status }: PanelStatusProps): ReactElement {
  return (
    <footer className="dsh-status" aria-live="polite">
      <span className={`dsh-status__dot dsh-status__dot--${status}`} aria-hidden="true" />
      <span className="dsh-status__state">{t(STATUS_KEY[status])}</span>
      <span className="dsh-status__spacer" />
      <span className="dsh-status__tokens">
        {t('status.tokens')}: 0 · 0.0 s
      </span>
    </footer>
  );
}

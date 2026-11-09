import type { ReactElement } from 'react';

import type { Translator } from '../i18n';
import type { ChatPanelStatus } from '../messages';
import type { ChatStreamStatus } from '../chat/reducer';

export interface PanelStatusProps {
  readonly t: Translator;
  readonly status: ChatPanelStatus;
  /** Статус потока: streaming/cancelled/error важнее «idle» каркаса. */
  readonly streamStatus: ChatStreamStatus;
  /** Текст ошибки для статус-строки. */
  readonly error?: string | null;
}

const STATUS_KEY = {
  idle: 'status.idle',
  thinking: 'status.thinking',
  stopped: 'status.stopped'
} as const;

/** Статус-строка панели: состояние потока, ошибка, токены и длительность. */
export function PanelStatus({
  t,
  status,
  streamStatus,
  error
}: PanelStatusProps): ReactElement {
  const label =
    streamStatus === 'streaming'
      ? t('status.streaming')
      : streamStatus === 'cancelled'
        ? t('status.cancelled')
        : streamStatus === 'error'
          ? `${t('status.error')}${error === undefined || error === null ? '' : `: ${error}`}`
          : t(STATUS_KEY[status]);

  const dot = streamStatus === 'idle' ? status : streamStatus;

  return (
    <footer className="dsh-status" aria-live="polite">
      <span className={`dsh-status__dot dsh-status__dot--${dot}`} aria-hidden="true" />
      <span className="dsh-status__state">{label}</span>
      <span className="dsh-status__spacer" />
      <span className="dsh-status__tokens">
        {t('status.tokens')}: 0 · 0.0 s
      </span>
    </footer>
  );
}

import type { ReactElement } from 'react';

import type { Translator } from '../i18n';
import type { ToolCallState } from './reducer';

export interface ToolCallBlockProps {
  readonly call: ToolCallState;
  readonly t: Translator;
}

/** Блок вызова инструмента: имя, статус, длительность, свёрнутые аргументы/результат. */
export function ToolCallBlock({ call, t }: ToolCallBlockProps): ReactElement {
  const durationMs =
    call.finishedAt === undefined ? undefined : Math.max(0, call.finishedAt - call.startedAt);
  const statusLabel =
    call.status === 'running'
      ? t('tool.status.running')
      : call.status === 'done'
        ? t('tool.status.done')
        : t('tool.status.error');

  return (
    <details className={`dsh-tool dsh-tool--${call.status}`} open={call.status === 'running'}>
      <summary className="dsh-tool__summary">
        <span className="dsh-tool__name">
          {t('tool.call')}: {call.name}
        </span>
        <span className="dsh-tool__status">{statusLabel}</span>
        {durationMs === undefined ? null : (
          <span className="dsh-tool__duration">
            {t('tool.duration')}: {String(durationMs)} ms
          </span>
        )}
      </summary>
      <div className="dsh-tool__body">
        <p className="dsh-tool__label">{t('tool.arguments')}</p>
        <pre className="dsh-tool__pre">{JSON.stringify(call.arguments, null, 2)}</pre>
        {call.result === undefined ? null : (
          <>
            <p className="dsh-tool__label">{t('tool.result')}</p>
            <pre className="dsh-tool__pre">
              {typeof call.result === 'string' ? call.result : JSON.stringify(call.result, null, 2)}
            </pre>
          </>
        )}
        {call.error === undefined ? null : (
          <p className="dsh-tool__error">{call.error}</p>
        )}
      </div>
    </details>
  );
}

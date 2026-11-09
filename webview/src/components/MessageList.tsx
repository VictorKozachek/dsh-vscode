import { useEffect, useRef } from 'react';
import type { ReactElement } from 'react';

import { MarkdownView } from '../chat/MarkdownView';
import { shouldAutoScroll } from '../chat/reducer';
import type { ChatEntryState } from '../chat/reducer';
import { ToolCallBlock } from '../chat/ToolCallBlock';
import type { Translator } from '../i18n';

export interface MessageListProps {
  readonly t: Translator;
  readonly entries: readonly ChatEntryState[];
}

/** Лента сообщений с tool-call блоками, markdown и умным автоскроллом. */
export function MessageList({ t, entries }: MessageListProps): ReactElement {
  const scrollRef = useRef<HTMLElement | null>(null);
  const stickToBottom = useRef(true);

  // Запоминаем, был ли пользователь у нижней границы: если нет — не дёргаем.
  const handleScroll = (): void => {
    const element = scrollRef.current;
    if (element === null) {
      return;
    }
    stickToBottom.current = shouldAutoScroll({
      scrollTop: element.scrollTop,
      scrollHeight: element.scrollHeight,
      clientHeight: element.clientHeight
    });
  };

  useEffect(() => {
    const element = scrollRef.current;
    if (element === null || !stickToBottom.current) {
      return;
    }
    element.scrollTop = element.scrollHeight;
  }, [entries]);

  return (
    <section
      ref={scrollRef}
      className="dsh-messages"
      role="log"
      aria-live="polite"
      aria-relevant="additions text"
      aria-label={t('log.label')}
      onScroll={handleScroll}
    >
      {entries.length === 0 ? (
        <div className="dsh-messages__empty">
          <p className="dsh-messages__empty-title">{t('empty.title')}</p>
          <p className="dsh-messages__empty-hint">{t('empty.hint')}</p>
        </div>
      ) : (
        entries.map((entry) => (
          <article key={entry.id} className={`dsh-message dsh-message--${entry.role}`}>
            <p className="dsh-message__author">
              {entry.role === 'user'
                ? t('message.you')
                : entry.role === 'assistant'
                  ? t('message.assistant')
                  : t('message.system')}
            </p>
            {entry.role === 'assistant' ? (
              <MarkdownView
                text={entry.text}
                copyLabel={t('markdown.copy')}
                copiedLabel={t('markdown.copied')}
              />
            ) : (
              <p className="dsh-message__text">{entry.text}</p>
            )}
            {entry.toolCalls.map((call) => (
              <ToolCallBlock key={call.id} call={call} t={t} />
            ))}
            {entry.state === 'streaming' ? (
              <span
                className="dsh-message__state dsh-message__state--streaming"
                aria-label={t('status.thinking')}
              />
            ) : null}
            {entry.state === 'cancelled' ? (
              <span className="dsh-message__state-badge">{t('message.cancelled')}</span>
            ) : null}
            {entry.state === 'error' ? (
              <span className="dsh-message__state-badge dsh-message__state-badge--error">
                {t('message.error')}
              </span>
            ) : null}
          </article>
        ))
      )}
    </section>
  );
}

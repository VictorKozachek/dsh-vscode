import { useEffect, useRef } from 'react';
import type { ReactElement } from 'react';

import type { Translator } from '../i18n';
import type { ChatMessage } from '../messages';

export interface MessageListProps {
  readonly t: Translator;
  readonly messages: readonly ChatMessage[];
}

/** Лента сообщений с пустым состоянием; автоскролл к последнему сообщению. */
export function MessageList({ t, messages }: MessageListProps): ReactElement {
  const endRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [messages.length]);

  return (
    <section
      className="dsh-messages"
      role="log"
      aria-live="polite"
      aria-relevant="additions text"
      aria-label={t('log.label')}
    >
      {messages.length === 0 ? (
        <div className="dsh-messages__empty">
          <p className="dsh-messages__empty-title">{t('empty.title')}</p>
          <p className="dsh-messages__empty-hint">{t('empty.hint')}</p>
        </div>
      ) : (
        messages.map((message) => (
          <article key={message.id} className={`dsh-message dsh-message--${message.role}`}>
            <p className="dsh-message__author">
              {message.role === 'user'
                ? t('message.you')
                : message.role === 'assistant'
                  ? t('message.assistant')
                  : t('message.system')}
            </p>
            <p className="dsh-message__text">{message.text}</p>
          </article>
        ))
      )}
      <div ref={endRef} />
    </section>
  );
}

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactElement } from 'react';

import { Composer } from './components/Composer';
import { Header } from './components/Header';
import { MessageList } from './components/MessageList';
import { PanelStatus } from './components/PanelStatus';
import { createTranslator, resolveLocale } from './i18n';
import type { ChatMessage, ChatPanelState, ExtensionToWebview } from './messages';
import { onExtensionMessage, postToExtension } from './vscodeApi';

/**
 * Панель DSH: шапка, лента, composer и статус-строка.
 *
 * Данные приходят из extension host (`state`, `message`, `status`), действия
 * уходят туда же (`ready`, `sendMessage`, `stop`). Эхо-ответ на этом этапе
 * делает extension host — реальный обмен через DshBridge появится в #008.
 */
export function App(): ReactElement {
  const [locale, setLocale] = useState<'ru' | 'en'>(() =>
    resolveLocale(typeof navigator === 'undefined' ? undefined : navigator.language)
  );
  const [panel, setPanel] = useState<ChatPanelState | null>(null);
  const [messages, setMessages] = useState<readonly ChatMessage[]>([]);
  const [draft, setDraft] = useState('');

  const t = useMemo(() => createTranslator(locale), [locale]);

  useEffect(() => {
    const dispose = onExtensionMessage((message: ExtensionToWebview) => {
      switch (message.type) {
        case 'state': {
          setPanel(message.state);
          setLocale(message.state.locale);
          break;
        }
        case 'message': {
          setMessages((previous) => [...previous, message.message]);
          break;
        }
        case 'status': {
          setPanel((previous) =>
            previous === null ? previous : { ...previous, status: message.status }
          );
          break;
        }
        case 'replaceMessages': {
          setMessages([...message.messages]);
          break;
        }
        default:
          break;
      }
    });

    postToExtension({ type: 'ready' });
    return dispose;
  }, []);

  const send = useCallback(() => {
    const text = draft.trim();
    if (text === '') {
      return;
    }
    postToExtension({ type: 'sendMessage', text });
    setDraft('');
  }, [draft]);

  const stop = useCallback(() => {
    postToExtension({ type: 'stop' });
  }, []);

  const status = panel?.status ?? 'idle';

  return (
    <main className="dsh-panel">
      <Header
        t={t}
        workspaceName={panel?.workspaceName ?? t('state.noWorkspace')}
        model={panel?.model ?? '—'}
        sandboxMode={panel?.sandboxMode ?? '—'}
        status={status}
        onStop={stop}
      />
      <MessageList t={t} messages={messages} />
      <Composer t={t} value={draft} onChange={setDraft} onSubmit={send} />
      <PanelStatus t={t} status={status} />
    </main>
  );
}

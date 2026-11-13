import { useCallback, useEffect, useMemo, useReducer, useState } from 'react';
import type { ReactElement } from 'react';

import { ApprovalCard } from './approvals/ApprovalCard';
import type { ApprovalDecisionKind } from './approvals/approvalModel';
import { chatFeedReducer, initialChatFeedState } from './chat/reducer';
import { Composer } from './components/Composer';
import { Header } from './components/Header';
import { MessageList } from './components/MessageList';
import { PanelStatus } from './components/PanelStatus';
import { createTranslator, resolveLocale } from './i18n';
import type {
  ApprovalRequestMessage,
  ChatPanelState,
  ChatPanelStatus,
  ExtensionToWebview
} from './messages';
import { onExtensionMessage, postToExtension } from './vscodeApi';

/**
 * Панель DSH: шапка, лента с потоковыми токенами и tool-call блоками,
 * composer и статус-строка.
 *
 * Лента собирается редьюсером `chatFeedReducer` из событий extension host
 * (`chatToken`, `chatToolCall`, `chatToolResult`, `chatDone`, `chatCancelled`,
 * `chatStatus`); «плоские» `message` остаются для эхо-режима каркаса.
 */
export function App(): ReactElement {
  const [locale, setLocale] = useState<'ru' | 'en'>(() =>
    resolveLocale(typeof navigator === 'undefined' ? undefined : navigator.language)
  );
  const [panel, setPanel] = useState<ChatPanelState | null>(null);
  const [feed, dispatch] = useReducer(chatFeedReducer, initialChatFeedState);
  const [draft, setDraft] = useState('');
  const [approvals, setApprovals] = useState<readonly ApprovalRequestMessage[]>([]);

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
          dispatch({ type: 'appendMessage', message: message.message });
          break;
        }
        case 'status': {
          setPanel((previous) =>
            previous === null ? previous : { ...previous, status: message.status }
          );
          break;
        }
        case 'replaceMessages': {
          dispatch({ type: 'replaceMessages', messages: message.messages });
          break;
        }
        case 'chatStatus': {
          dispatch({ type: 'status', status: message.status });
          if (message.status === 'error') {
            dispatch({ type: 'error', message: message.detail ?? 'DSH error' });
          }
          break;
        }
        case 'chatToken': {
          dispatch({ type: 'token', turnId: message.turnId, text: message.text });
          break;
        }
        case 'chatToolCall': {
          dispatch({
            type: 'toolCall',
            callId: message.call.id,
            name: message.call.name,
            arguments: message.call.arguments
          });
          break;
        }
        case 'chatToolResult': {
          dispatch(
            message.result.error === undefined
              ? {
                  type: 'toolResult',
                  callId: message.result.callId,
                  ok: message.result.ok,
                  result: message.result.result
                }
              : {
                  type: 'toolResult',
                  callId: message.result.callId,
                  ok: message.result.ok,
                  error: message.result.error
                }
          );
          break;
        }
        case 'chatDone': {
          dispatch({
            type: 'done',
            turnId: message.turnId,
            finishReason: message.finishReason
          });
          break;
        }
        case 'chatCancelled': {
          dispatch({ type: 'cancelled' });
          break;
        }
        case 'approvalRequest': {
          setApprovals((previous) =>
            previous.some((item) => item.id === message.request.id)
              ? previous
              : [...previous, message.request]
          );
          break;
        }
        case 'approvalResolved': {
          setApprovals((previous) => previous.filter((item) => item.id !== message.id));
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

  const resolveApproval = useCallback((id: string, decision: ApprovalDecisionKind) => {
    setApprovals((previous) => previous.filter((item) => item.id !== id));
    postToExtension({ type: 'approvalResolve', id, decision });
  }, []);

  const showApprovalDiff = useCallback((id: string) => {
    postToExtension({ type: 'approvalShowDiff', id });
  }, []);

  // Эхо-режим каркаса (без ChatController) шлёт chatStatus из ChatSession,
  // а потоковый — свои статусы; учитываем оба, иначе Stop «залипает».
  const panelStatus: ChatPanelStatus =
    feed.status === 'streaming'
      ? 'thinking'
      : feed.status === 'cancelled'
        ? 'stopped'
        : feed.status === 'error'
          ? 'stopped'
          : (panel?.status ?? 'idle');

  return (
    <main className="dsh-panel">
      <Header
        t={t}
        workspaceName={panel?.workspaceName ?? t('state.noWorkspace')}
        model={panel?.model ?? '—'}
        sandboxMode={panel?.sandboxMode ?? '—'}
        status={panelStatus}
        onStop={stop}
      />
      <MessageList t={t} entries={feed.entries} />
      {approvals.map((request) => (
        <ApprovalCard
          key={request.id}
          t={t}
          request={request}
          onDecision={resolveApproval}
          onShowDiff={showApprovalDiff}
        />
      ))}
      <Composer t={t} value={draft} onChange={setDraft} onSubmit={send} />
      <PanelStatus t={t} status={panelStatus} streamStatus={feed.status} error={feed.error} />
    </main>
  );
}

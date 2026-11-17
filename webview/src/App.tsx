import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import type { ReactElement } from 'react';

import { ApprovalCard } from './approvals/ApprovalCard';
import type { ApprovalDecisionKind } from './approvals/approvalModel';
import { chatFeedReducer, initialChatFeedState } from './chat/reducer';
import { DraftStore, switchSessionDraft } from './chat/drafts';
import { Composer } from './components/Composer';
import { Header } from './components/Header';
import { MessageList } from './components/MessageList';
import { PanelStatus } from './components/PanelStatus';
import { createTranslator, resolveLocale } from './i18n';
import type {
  ApprovalRequestMessage,
  ChatPanelState,
  ChatPanelStatus,
  ChatSessionDto,
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
  const [session, setSession] = useState<ChatSessionDto | null>(null);
  const draftsRef = useRef(new DraftStore());
  const activeSessionRef = useRef<string | null>(null);
  const draftRef = useRef('');

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
        case 'replaceFeed': {
          dispatch({
            type: 'replaceFeed',
            records: message.records.map((record) =>
              record.kind === 'message'
                ? { kind: 'message' as const, message: record.message }
                : record.kind === 'toolCall'
                  ? {
                      kind: 'toolCall' as const,
                      callId: record.call.id,
                      name: record.call.name,
                      arguments: record.call.arguments
                    }
                  : {
                      kind: 'toolResult' as const,
                      callId: record.result.callId,
                      ok: record.result.ok,
                      ...(record.result.error === undefined
                        ? { result: record.result.result }
                        : { error: record.result.error })
                    }
            )
          });
          break;
        }
        case 'chatSession': {
          const previousId = activeSessionRef.current;
          const nextId = message.session.sessionId;
          if (previousId !== nextId) {
            const next = switchSessionDraft(
              draftsRef.current,
              previousId,
              nextId,
              draftRef.current
            );
            activeSessionRef.current = nextId;
            draftRef.current = next;
            setDraft(next);
          }
          setSession(message.session);
          break;
        }
        case 'composerDraft': {
          draftsRef.current.set(activeSessionRef.current, message.text);
          draftRef.current = message.text;
          setDraft(message.text);
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
    // Блокируем только явную сессию без id; при отсутствии chatSession —
    // эхо-режим каркаса (#005), отправка должна работать.
    if (session !== null && session.sessionId === null) {
      return;
    }
    const text = draft.trim();
    if (text === '') {
      return;
    }
    draftsRef.current.set(activeSessionRef.current, '');
    draftRef.current = '';
    setDraft('');
    postToExtension({ type: 'draftChanged', text: '' });
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

  const changeDraft = useCallback(
    (value: string) => {
      draftRef.current = value;
      setDraft(value);
      draftsRef.current.set(activeSessionRef.current, value);
      postToExtension({ type: 'draftChanged', text: value });
    },
    []
  );

  const openNewSession = useCallback(() => {
    postToExtension({ type: 'openNewSession' });
  }, []);

  const retryChat = useCallback(() => {
    postToExtension({ type: 'retryChat' });
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
        sessionTitle={session?.title ?? null}
        sessionStatus={session?.status}
        sessionModel={session?.model}
        sessionPreset={session?.preset}
      />
      {feed.status === 'error' || session?.status === 'error' || session?.status === 'offline' ? (
        <div className="dsh-banner" role="alert">
          <span>{feed.error ?? t('status.error')}</span>
          <button type="button" className="dsh-button" onClick={retryChat}>
            {t('chat.retry')}
          </button>
        </div>
      ) : null}
      {session?.historyState === 'unavailable' ? (
        <p className="dsh-chat-note">{t('chat.historyUnavailable')}</p>
      ) : null}
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
      <Composer
        t={t}
        value={draft}
        onChange={changeDraft}
        onSubmit={send}
        disabled={session !== null && session.sessionId === null}
        onCreateSession={openNewSession}
      />
      <PanelStatus t={t} status={panelStatus} streamStatus={feed.status} error={feed.error} />
    </main>
  );
}

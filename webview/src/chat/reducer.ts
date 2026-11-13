/**
 * Редьюсер ленты чата: события из extension host → состояние панели.
 *
 * Чистый модуль без импортов (React и DOM не нужны), поэтому покрыт тестами в
 * Node (`tests/chat-feed-reducer.test.mjs`).
 */

/** Статус потока ответа. */
export type ChatStreamStatus = 'idle' | 'streaming' | 'cancelled' | 'error';

/** Статус вызова инструмента. */
export type ToolCallStatus = 'running' | 'done' | 'error';

/** Состояние вызова инструмента в ленте. */
export interface ToolCallState {
  readonly id: string;
  readonly name: string;
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly status: ToolCallStatus;
  readonly result?: unknown;
  readonly error?: string;
  readonly startedAt: number;
  readonly finishedAt?: number;
}

/** Состояние сообщения. */
export type ChatEntryStatus = 'done' | 'streaming' | 'cancelled' | 'error';

/** Сообщение в ленте. */
export interface ChatEntryState {
  readonly id: string;
  readonly role: 'user' | 'assistant' | 'system';
  readonly text: string;
  readonly toolCalls: readonly ToolCallState[];
  readonly state: ChatEntryStatus;
}

/** Состояние ленты целиком. */
export interface ChatFeedState {
  readonly entries: readonly ChatEntryState[];
  readonly status: ChatStreamStatus;
  readonly turnId: string | null;
  readonly error: string | null;
}

/** События, которые двигают ленту. */
export type ChatFeedEvent =
  | { readonly type: 'userMessage'; readonly text: string; readonly at?: number }
  | { readonly type: 'token'; readonly turnId: string; readonly text: string }
  | {
      readonly type: 'toolCall';
      readonly callId: string;
      readonly name: string;
      readonly arguments: Record<string, unknown>;
      readonly at?: number;
    }
  | {
      readonly type: 'toolResult';
      readonly callId: string;
      readonly ok: boolean;
      readonly result?: unknown;
      readonly error?: string;
      readonly at?: number;
    }
  | {
      readonly type: 'done';
      readonly turnId: string;
      readonly finishReason: 'stop' | 'cancelled' | 'error';
    }
  | { readonly type: 'cancelled' }
  | { readonly type: 'error'; readonly message: string }
  | { readonly type: 'status'; readonly status: ChatStreamStatus }
  | {
      readonly type: 'appendMessage';
      readonly message: { readonly id: string; readonly role: 'user' | 'assistant' | 'system'; readonly text: string };
    }
  | {
      readonly type: 'replaceMessages';
      readonly messages: readonly {
        readonly id: string;
        readonly role: 'user' | 'assistant' | 'system';
        readonly text: string;
      }[];
    }
  | {
      readonly type: 'replaceFeed';
      readonly records: readonly (
        | {
            readonly kind: 'message';
            readonly message: {
              readonly id: string;
              readonly role: 'user' | 'assistant' | 'system';
              readonly text: string;
            };
          }
        | {
            readonly kind: 'toolCall';
            readonly callId: string;
            readonly name: string;
            readonly arguments: Record<string, unknown>;
          }
        | {
            readonly kind: 'toolResult';
            readonly callId: string;
            readonly ok: boolean;
            readonly result?: unknown;
            readonly error?: string;
          }
      )[];
    };

/** Начальное состояние. */
export const initialChatFeedState: ChatFeedState = {
  entries: [],
  status: 'idle',
  turnId: null,
  error: null
};

/** Редьюсер ленты. */
export function chatFeedReducer(state: ChatFeedState, event: ChatFeedEvent): ChatFeedState {
  switch (event.type) {
    case 'userMessage': {
      const entry: ChatEntryState = {
        id: `user-${String(state.entries.length + 1)}`,
        role: 'user',
        text: event.text,
        toolCalls: [],
        state: 'done'
      };
      return { ...state, entries: [...state.entries, entry], error: null };
    }

    case 'replaceMessages': {
      return {
        ...state,
        entries: event.messages.map((message) => ({
          id: message.id,
          role: message.role,
          text: message.text,
          toolCalls: [],
          state: 'done' as const
        })),
        status: 'idle',
        turnId: null,
        error: null
      };
    }

    case 'replaceFeed': {
      const entries: ChatEntryState[] = [];
      for (const record of event.records) {
        if (record.kind === 'message') {
          entries.push({
            id: record.message.id,
            role: record.message.role,
            text: record.message.text,
            toolCalls: [],
            state: 'done'
          });
          continue;
        }
        if (record.kind === 'toolCall') {
          const call: ToolCallState = {
            id: record.callId,
            name: record.name,
            arguments: record.arguments,
            status: 'running',
            startedAt: 0
          };
          const last = entries[entries.length - 1];
          if (last !== undefined && last.role === 'assistant') {
            entries[entries.length - 1] = { ...last, toolCalls: [...last.toolCalls, call] };
          } else {
            entries.push({
              id: `assistant-${String(entries.length + 1)}`,
              role: 'assistant',
              text: '',
              toolCalls: [call],
              state: 'done'
            });
          }
          continue;
        }
        for (let index = 0; index < entries.length; index += 1) {
          const entry = entries[index];
          if (entry === undefined || !entry.toolCalls.some((call) => call.id === record.callId)) {
            continue;
          }
          entries[index] = {
            ...entry,
            toolCalls: entry.toolCalls.map((call) =>
              call.id === record.callId
                ? {
                    ...call,
                    status: record.ok ? ('done' as const) : ('error' as const),
                    finishedAt: 0,
                    ...(record.error === undefined ? { result: record.result } : { error: record.error })
                  }
                : call
            )
          };
        }
      }
      return { ...state, entries, status: 'idle', turnId: null, error: null };
    }

    case 'appendMessage': {
      const entry: ChatEntryState = {
        id: event.message.id,
        role: event.message.role,
        text: event.message.text,
        toolCalls: [],
        state: 'done'
      };
      return { ...state, entries: [...state.entries, entry] };
    }

    case 'token': {
      if (state.status === 'cancelled' || state.status === 'error') {
        return state;
      }
      if (state.turnId !== null && event.turnId !== state.turnId) {
        return state; // поздний токен прошлого хода
      }
      const entries = [...state.entries];
      const lastIndex = entries.length - 1;
      const last = entries[lastIndex];
      if (last !== undefined && last.role === 'assistant' && last.state === 'streaming') {
        entries[lastIndex] = { ...last, text: last.text + event.text };
      } else {
        entries.push({
          id: `assistant-${String(entries.length + 1)}`,
          role: 'assistant',
          text: event.text,
          toolCalls: [],
          state: 'streaming'
        });
      }
      return { ...state, entries, status: 'streaming', turnId: event.turnId, error: null };
    }

    case 'toolCall': {
      if (state.status === 'cancelled' || state.status === 'error') {
        return state;
      }
      const entries = [...state.entries];
      const lastIndex = entries.length - 1;
      const last = entries[lastIndex];
      const call: ToolCallState = {
        id: event.callId,
        name: event.name,
        arguments: event.arguments,
        status: 'running',
        startedAt: event.at ?? Date.now()
      };
      if (last !== undefined && last.role === 'assistant' && last.state === 'streaming') {
        entries[lastIndex] = { ...last, toolCalls: [...last.toolCalls, call] };
      } else {
        entries.push({
          id: `assistant-${String(entries.length + 1)}`,
          role: 'assistant',
          text: '',
          toolCalls: [call],
          state: 'streaming'
        });
      }
      return { ...state, entries };
    }

    case 'toolResult': {
      if (state.status === 'cancelled' || state.status === 'error') {
        return state;
      }
      const at = event.at ?? Date.now();
      const entries = state.entries.map((entry) => {
        if (!entry.toolCalls.some((call) => call.id === event.callId)) {
          return entry;
        }
        return {
          ...entry,
          toolCalls: entry.toolCalls.map((call) =>
            call.id === event.callId
              ? {
                  ...call,
                  status: event.ok ? ('done' as const) : ('error' as const),
                  finishedAt: at,
                  ...(event.error === undefined
                    ? { result: event.result }
                    : { error: event.error })
                }
              : call
          )
        };
      });
      return { ...state, entries };
    }

    case 'done': {
      if (state.turnId !== null && event.turnId !== state.turnId) {
        return state; // старый turn.done не закрывает новый ход
      }
      const entryState: ChatEntryStatus =
        event.finishReason === 'error'
          ? 'error'
          : event.finishReason === 'cancelled'
            ? 'cancelled'
            : 'done';
      return {
        ...state,
        entries: state.entries.map((entry) =>
          entry.state === 'streaming'
            ? {
                ...entry,
                state: entryState,
                toolCalls: interruptRunningCalls(entry.toolCalls, entryState)
              }
            : entry
        ),
        status:
          event.finishReason === 'error'
            ? 'error'
            : event.finishReason === 'cancelled'
              ? 'cancelled'
              : 'idle',
        turnId: null
      };
    }

    case 'cancelled': {
      return {
        ...state,
        entries: state.entries.map((entry) =>
          entry.state === 'streaming'
            ? {
                ...entry,
                state: 'cancelled',
                toolCalls: interruptRunningCalls(entry.toolCalls, 'cancelled')
              }
            : entry
        ),
        status: 'cancelled',
        turnId: null
      };
    }

    case 'error': {
      return {
        ...state,
        entries: state.entries.map((entry) =>
          entry.state === 'streaming'
            ? {
                ...entry,
                state: 'error',
                toolCalls: interruptRunningCalls(entry.toolCalls, event.message)
              }
            : entry
        ),
        status: 'error',
        turnId: null,
        error: event.message
      };
    }

    case 'status': {
      return { ...state, status: event.status };
    }

    default:
      return state;
  }
}

/** Параметры автопрокрутки. */
export interface AutoScrollInput {
  readonly scrollTop: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
  /** Насколько близко к низу считается «у нижней границы». */
  readonly threshold?: number;
}

/**
 * Автоскролл только если пользователь у нижней границы: иначе чтение
 * предыдущих сообщений не должно дёргаться от новых токенов.
 */
export function shouldAutoScroll(input: AutoScrollInput): boolean {
  const threshold = input.threshold ?? 48;
  if (input.scrollHeight <= input.clientHeight) {
    return true;
  }
  const distanceFromBottom = input.scrollHeight - input.scrollTop - input.clientHeight;
  return distanceFromBottom <= threshold;
}

/** Прерванные вызовы инструментов: pending-статус не должен «висеть». */
function interruptRunningCalls(
  calls: readonly ToolCallState[],
  reason: string
): readonly ToolCallState[] {
  return calls.map((call) =>
    call.status === 'running'
      ? { ...call, status: 'error', error: reason }
      : call
  );
}

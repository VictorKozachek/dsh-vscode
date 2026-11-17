/**
 * Маппинг нашего DSH JSON-RPC API (`protocol/`) на ACP (Agent Client Protocol),
 * который отдаёт `dsh --profile acp` по stdio (#021).
 *
 * Публичный API `DshBridge` не меняется: session.list/create/resume,
 * turn.start/cancel остаются методами нашего протокола, а рантайм переводит их
 * в `session/list`, `session/new`, `session/resume`, `session/prompt`,
 * `session/cancel` и обратно. Модуль без побочных эффектов — покрыт тестами
 * `tests/acp-protocol.test.mjs`.
 */

import type { DshEvent, DshMethod } from '@dsh-vscode/protocol';

/** Вызов ACP: метод, параметры; notification — без ответа. */
export interface AcpCall {
  readonly method: string;
  readonly params: Record<string, unknown>;
  readonly notification?: boolean;
}

/** Ошибка «метод нашего API не поддержан ACP-транспортом». */
export class AcpUnsupportedMethodError extends Error {
  constructor(method: string) {
    super(`ACP-рантайм не поддерживает метод ${method}`);
    this.name = 'AcpUnsupportedMethodError';
  }
}

/** Наш метод → вызов ACP. `null` — метод обслуживается локально. */
export function toAcpCall(
  method: DshMethod,
  params: Readonly<Record<string, unknown>>,
  cwd: string
): AcpCall | null {
  switch (method) {
    case 'session.list':
      return { method: 'session/list', params: { cwd } };

    case 'session.create': {
      // Дополнительные параметры профиля (#023) доходят до рантайма; ACP
      // игнорирует неизвестные ключи, а fake-ACP проверяет их наличие.
      const extra: Record<string, unknown> = {};
      for (const key of ['model', 'preset', 'sandbox', 'approval']) {
        const value = params[key];
        if (typeof value === 'string' && value !== '') {
          extra[key] = value;
        }
      }
      return {
        method: 'session/new',
        params: { cwd, mcpServers: [], ...extra }
      };
    }

    case 'session.resume':
      return {
        method: 'session/resume',
        params: {
          sessionId: String(params['sessionId'] ?? ''),
          cwd,
          mcpServers: []
        }
      };

    case 'turn.start':
      return {
        method: 'session/prompt',
        params: {
          sessionId: String(params['sessionId'] ?? ''),
          prompt: [{ type: 'text', text: String(params['input'] ?? '') }]
        }
      };

    case 'turn.cancel':
      return {
        method: 'session/cancel',
        params: { sessionId: String(params['sessionId'] ?? '') },
        notification: true
      };

    case 'tools.invoke':
    case 'approval.resolve':
    case 'context.reload':
      throw new AcpUnsupportedMethodError(method);

    case 'workspace.ping':
      return null;

    default:
      throw new AcpUnsupportedMethodError(String(method));
  }
}

/** Сессия в нашем формате. */
export interface AcpSessionSummary {
  readonly id: string;
  readonly workspaceId: string;
  readonly title?: string | undefined;
  readonly updatedAt: string;
}

/** `session/list` → `session.list`. */
export function mapListResult(
  result: unknown,
  workspaceId: string | undefined,
  cwd: string,
  now: string
): { sessions: readonly AcpSessionSummary[] } {
  const sessions = Array.isArray((result as { sessions?: unknown })?.sessions)
    ? ((result as { sessions: unknown[] }).sessions as unknown[])
    : [];
  return {
    sessions: sessions
      .filter(isRecord)
      .map((session) => {
        const id = typeof session['sessionId'] === 'string' ? session['sessionId'] : '';
        return {
          id,
          workspaceId: workspaceId ?? cwd,
          ...(typeof session['title'] === 'string' ? { title: session['title'] } : {}),
          updatedAt: typeof session['updatedAt'] === 'string' ? session['updatedAt'] : now
        };
      })
      .filter((session) => session.id !== '')
  };
}

/** `session/new` → `session.create`. */
export function mapCreateResult(
  result: unknown,
  now: string
): { sessionId: string; createdAt: string } {
  const sessionId =
    typeof (result as { sessionId?: unknown })?.sessionId === 'string'
      ? (result as { sessionId: string }).sessionId
      : '';
  if (sessionId === '') {
    throw new Error('ACP session/new не вернул sessionId');
  }
  return { sessionId, createdAt: now };
}

/** `session/resume` → `session.resume`. */
export function mapResumeResult(
  result: unknown,
  sessionId: string,
  workspaceId: string,
  now: string
): { session: AcpSessionSummary } {
  const configOptions = (result as { configOptions?: unknown })?.configOptions;
  void configOptions;
  return {
    session: { id: sessionId, workspaceId, updatedAt: now }
  };
}

/** Результат `session/prompt` → `turn.done`. */
export function mapPromptOutcome(
  sessionId: string,
  turnId: string,
  result: unknown
): { event: 'turn.done'; payload: Record<string, unknown> } {
  const stopReason = (result as { stopReason?: unknown })?.stopReason;
  const finishReason =
    stopReason === 'cancelled' ? 'cancelled' : stopReason === 'refusal' ? 'error' : 'stop';
  return { event: 'turn.done', payload: { sessionId, turnId, finishReason } };
}

/** Уведомление ACP → событие нашего протокола (или `null`). */
export function mapAcpNotification(
  method: string,
  params: unknown
): { event: DshEvent; payload: Record<string, unknown> } | null {
  if (method !== 'session/update' || !isRecord(params)) {
    return null;
  }
  const sessionId = typeof params['sessionId'] === 'string' ? params['sessionId'] : '';
  const update = params['update'];
  if (sessionId === '' || !isRecord(update)) {
    return null;
  }
  const turnId = typeof params['turnId'] === 'string' ? params['turnId'] : sessionId;

  switch (update['sessionUpdate']) {
    case 'agent_message_chunk': {
      const content = update['content'];
      const text =
        isRecord(content) && content['type'] === 'text' && typeof content['text'] === 'string'
          ? content['text']
          : '';
      return text === ''
        ? null
        : { event: 'token', payload: { sessionId, turnId, text } };
    }

    case 'tool_call': {
      const callId = typeof update['toolCallId'] === 'string' ? update['toolCallId'] : '';
      if (callId === '') {
        return null;
      }
      return {
        event: 'tool.call',
        payload: {
          sessionId,
          callId,
          name:
            typeof update['title'] === 'string'
              ? update['title']
              : typeof update['kind'] === 'string'
                ? update['kind']
                : 'tool',
          arguments: isRecord(update['rawInput']) ? update['rawInput'] : {}
        }
      };
    }

    case 'tool_call_update': {
      const callId = typeof update['toolCallId'] === 'string' ? update['toolCallId'] : '';
      const status = update['status'];
      if (callId === '' || (status !== 'completed' && status !== 'failed')) {
        return null;
      }
      return {
        event: 'tool.result',
        payload: {
          sessionId,
          callId,
          ok: status === 'completed',
          ...(status === 'failed'
            ? {
                error:
                  typeof update['title'] === 'string' ? update['title'] : 'инструмент завершился ошибкой'
              }
            : { result: update['rawOutput'] ?? update['content'] ?? null })
        }
      };
    }

    default:
      return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Сессия из ACP `session/list` может называть поле `sessionId`. */
export type { DshEvent, DshMethod };

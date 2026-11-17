/**
 * ACP (Agent Client Protocol) — реальный транспорт DSH-рантайма (#021).
 *
 * `dsh --profile acp` говорит NDJSON JSON-RPC 2.0; здесь зафиксированы имена
 * методов и формы payload'ов, которые использует `AcpRuntime`. Совместимость
 * маппинга с этими типами проверяет `tests/acp-protocol.test.mjs`.
 */

/** Методы ACP, которыми пользуется расширение. */
export const ACP_METHODS = {
  initialize: 'initialize',
  sessionList: 'session/list',
  sessionNew: 'session/new',
  sessionResume: 'session/resume',
  sessionClose: 'session/close',
  sessionPrompt: 'session/prompt',
  sessionCancel: 'session/cancel',
  sessionUpdate: 'session/update',
  requestPermission: 'session/request_permission'
} as const;

/** `initialize` → результат. */
export interface AcpInitializeResult {
  readonly protocolVersion: number;
  readonly agentInfo: { readonly name: string; readonly version: string };
  readonly agentCapabilities?: Record<string, unknown>;
}

/** `session/list` → результат. */
export interface AcpSessionListResult {
  readonly sessions: readonly {
    readonly sessionId: string;
    readonly cwd?: string;
    readonly title?: string;
    readonly updatedAt?: string;
  }[];
}

/** `session/new` или `session/resume` → результат. */
export interface AcpSessionNewResult {
  readonly sessionId?: string;
  readonly configOptions?: readonly unknown[];
}

/** Параметры `session/prompt`. */
export interface AcpPromptParams {
  readonly sessionId: string;
  readonly prompt: readonly { readonly type: 'text'; readonly text: string }[];
}

/** Результат `session/prompt`. */
export interface AcpPromptResult {
  readonly stopReason: 'end_turn' | 'cancelled' | 'refusal' | string;
}

/** Уведомление `session/update`. */
export interface AcpSessionUpdateParams {
  readonly sessionId: string;
  readonly update: {
    readonly sessionUpdate: 'agent_message_chunk' | 'tool_call' | 'tool_call_update' | string;
    readonly content?: { readonly type: 'text'; readonly text: string };
    readonly toolCallId?: string;
    readonly title?: string;
    readonly kind?: string;
    readonly status?: string;
    readonly rawInput?: Record<string, unknown>;
    readonly rawOutput?: unknown;
  };
}

/** Запрос `session/request_permission`. */
export interface AcpRequestPermissionParams {
  readonly sessionId: string;
  readonly toolCall?: { readonly toolCallId?: string; readonly title?: string };
  readonly options?: readonly { readonly optionId: string; readonly name?: string }[];
}

/** Ответ на permission-запрос. */
export type AcpPermissionOutcome =
  | { readonly outcome: 'cancelled' }
  | { readonly outcome: 'selected'; readonly optionId: string };

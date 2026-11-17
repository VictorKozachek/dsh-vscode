/**
 * Протокол моста DSH ↔ VS Code.
 *
 * Здесь живут:
 *
 * - конверт JSON-RPC 2.0 (запрос, ответ, ошибка, уведомление);
 * - методы, которые клиент (расширение) вызывает у `dsh serve`;
 * - события, которые сервер присылает уведомлениями;
 * - типизированные карты `DshMethods`/`DshEvents` и рантайм-проверки имён.
 *
 * Схема одна на обе стороны: `extension/` не дублирует имена методов и события,
 * а берёт их отсюда (#004). Наполнение — §5.2 спецификации.
 */

/** Версия протокола моста; ломающие изменения увеличивают её. */
export const PROTOCOL_VERSION = '0.1.0' as const;

/** Версия JSON-RPC, поверх которой работает мост. */
export const JSONRPC_VERSION = '2.0' as const;

/** Идентификатор запроса: строка или число. */
export type JsonRpcId = string | number;

/** Параметры запроса/уведомления. */
export type JsonRpcParams = Record<string, unknown> | readonly unknown[] | undefined;

/** Объект ошибки JSON-RPC 2.0. */
export interface JsonRpcErrorObject {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}

/** Запрос, который ждёт ответа. */
export interface JsonRpcRequest {
  readonly jsonrpc: typeof JSONRPC_VERSION;
  readonly id: JsonRpcId;
  readonly method: string;
  readonly params?: JsonRpcParams;
}

/** Уведомление — запрос без `id`, ответа не ждёт. */
export interface JsonRpcNotification {
  readonly jsonrpc: typeof JSONRPC_VERSION;
  readonly method: string;
  readonly params?: JsonRpcParams;
}

/** Успешный ответ. */
export interface JsonRpcSuccessResponse<TResult = unknown> {
  readonly jsonrpc: typeof JSONRPC_VERSION;
  readonly id: JsonRpcId;
  readonly result: TResult;
}

/** Ответ с ошибкой. */
export interface JsonRpcErrorResponse {
  readonly jsonrpc: typeof JSONRPC_VERSION;
  readonly id: JsonRpcId | null;
  readonly error: JsonRpcErrorObject;
}

/** Любой ответ сервера. */
export type JsonRpcResponse<TResult = unknown> =
  | JsonRpcSuccessResponse<TResult>
  | JsonRpcErrorResponse;

/** Любое сообщение, которое может прийти по stdio. */
export type JsonRpcMessage =
  | JsonRpcRequest
  | JsonRpcNotification
  | JsonRpcResponse;

/** Проверка, что входящее сообщение — ответ на запрос. */
export function isJsonRpcResponse(message: JsonRpcMessage): message is JsonRpcResponse {
  return 'id' in message && ('result' in message || 'error' in message);
}

// --- методы -----------------------------------------------------------------

/** Методы, которые клиент вызывает у `dsh serve` (§5.2). */
export const DSH_METHODS = [
  'session.create',
  'session.resume',
  'session.list',
  'turn.start',
  'turn.cancel',
  'tools.invoke',
  'approval.resolve',
  'context.reload',
  'workspace.ping'
] as const;

/** Имя метода DSH. */
export type DshMethod = (typeof DSH_METHODS)[number];

/** Метод healthcheck супервизора: `workspace.ping`. */
export const WORKSPACE_PING_METHOD = 'workspace.ping' as const satisfies DshMethod;

/** Sandbox-режим, с которым поднимается `dsh serve` (§8). */
export type DshSandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';

/** Краткое описание сессии (реестр/список). */
export interface DshSessionSummary {
  readonly id: string;
  readonly workspaceId: string;
  readonly title?: string;
  readonly status?: 'active' | 'paused';
  readonly updatedAt: string;
}

/** `session.create`. */
export interface SessionCreateParams {
  readonly workspaceId: string;
  readonly model?: string;
  readonly title?: string;
}

export interface SessionCreateResult {
  readonly sessionId: string;
  readonly createdAt: string;
}

/** `session.resume`. */
export interface SessionResumeParams {
  readonly sessionId: string;
}

export interface SessionResumeResult {
  readonly session: DshSessionSummary;
}

/** `session.list`. */
export interface SessionListParams {
  readonly workspaceId?: string;
}

export interface SessionListResult {
  readonly sessions: readonly DshSessionSummary[];
}

/** `turn.start`. */
export interface TurnStartParams {
  readonly sessionId: string;
  readonly input: string;
  readonly attachments?: readonly string[];
}

export interface TurnStartResult {
  readonly turnId: string;
  readonly sessionId: string;
}

/** `turn.cancel`. */
export interface TurnCancelParams {
  readonly sessionId: string;
  readonly turnId: string;
}

export interface TurnCancelResult {
  readonly cancelled: boolean;
}

/** `tools.invoke`. */
export interface ToolsInvokeParams {
  readonly sessionId: string;
  readonly name: string;
  readonly arguments: Record<string, unknown>;
}

export interface ToolsInvokeResult {
  readonly ok: boolean;
  readonly result?: unknown;
  readonly error?: string;
}

/** `approval.resolve` (§8). */
export interface ApprovalResolveParams {
  readonly sessionId: string;
  readonly approvalId: string;
  readonly decision: 'allow' | 'allow-session' | 'deny';
}

export interface ApprovalResolveResult {
  readonly resolved: boolean;
}

/** `context.reload`. */
export interface ContextReloadParams {
  readonly workspaceId: string;
}

export interface ContextReloadResult {
  readonly reloaded: boolean;
  readonly hash?: string;
}

/** `workspace.ping` — healthcheck супервизора. */
export interface WorkspacePingParams {
  readonly workspaceId?: string;
}

export interface WorkspacePingResult {
  readonly pong: true;
  readonly protocolVersion?: string;
}

/** Карта «метод → параметры и результат». */
export interface DshMethods {
  'session.create': { params: SessionCreateParams; result: SessionCreateResult };
  'session.resume': { params: SessionResumeParams; result: SessionResumeResult };
  'session.list': { params: SessionListParams; result: SessionListResult };
  'turn.start': { params: TurnStartParams; result: TurnStartResult };
  'turn.cancel': { params: TurnCancelParams; result: TurnCancelResult };
  'tools.invoke': { params: ToolsInvokeParams; result: ToolsInvokeResult };
  'approval.resolve': { params: ApprovalResolveParams; result: ApprovalResolveResult };
  'context.reload': { params: ContextReloadParams; result: ContextReloadResult };
  'workspace.ping': { params: WorkspacePingParams; result: WorkspacePingResult };
}

/** Параметры метода. */
export type DshMethodParams<M extends DshMethod> = DshMethods[M]['params'];

/** Результат метода. */
export type DshMethodResult<M extends DshMethod> = DshMethods[M]['result'];

// --- события ----------------------------------------------------------------

/** События, которые сервер присылает уведомлениями (§5.2). */
export const DSH_EVENTS = [
  'token',
  'tool.call',
  'tool.result',
  'approval.request',
  'turn.done',
  'error',
  'status'
] as const;

/** Имя события DSH. */
export type DshEvent = (typeof DSH_EVENTS)[number];

/** `token` — очередной кусок ответа модели. */
export interface TokenEvent {
  readonly sessionId: string;
  readonly turnId: string;
  readonly text: string;
}

/** `tool.call` — агент вызывает инструмент. */
export interface ToolCallEvent {
  readonly sessionId: string;
  readonly callId: string;
  readonly name: string;
  readonly arguments: Record<string, unknown>;
}

/** `tool.result` — результат инструмента. */
export interface ToolResultEvent {
  readonly sessionId: string;
  readonly callId: string;
  readonly ok: boolean;
  readonly result?: unknown;
  readonly error?: string;
}

/** `approval.request` — запрос подтверждения (§8). */
export interface ApprovalRequestEvent {
  readonly sessionId: string;
  readonly approvalId: string;
  readonly tool: string;
  readonly details?: Record<string, unknown>;
}

/** `turn.done` — ход завершён. */
export interface TurnDoneEvent {
  readonly sessionId: string;
  readonly turnId: string;
  readonly finishReason: 'stop' | 'cancelled' | 'error';
}

/** `error` — ошибка вне конкретного запроса. */
export interface ErrorEvent {
  readonly message: string;
  readonly code?: number;
  readonly sessionId?: string;
}

/** `status` — состояние сервера/сессии. */
export interface StatusEvent {
  readonly state: 'ready' | 'busy' | 'paused' | 'stopped';
  readonly sessionId?: string;
}

/** Карта «событие → полезная нагрузка». */
export interface DshEvents {
  token: TokenEvent;
  'tool.call': ToolCallEvent;
  'tool.result': ToolResultEvent;
  'approval.request': ApprovalRequestEvent;
  'turn.done': TurnDoneEvent;
  error: ErrorEvent;
  status: StatusEvent;
}

/** Полезная нагрузка события. */
export type DshEventPayload<E extends DshEvent> = DshEvents[E];

/** Проверка, что строка — известный метод DSH. */
export function isDshMethod(value: string): value is DshMethod {
  return (DSH_METHODS as readonly string[]).includes(value);
}

/** Проверка, что строка — известное событие DSH. */
export function isDshEvent(value: string): value is DshEvent {
  return (DSH_EVENTS as readonly string[]).includes(value);
}

// --- ACP-транспорт (#021) ---------------------------------------------------

export * from './acp.js';

/**
 * Протокол моста DSH ↔ VS Code.
 *
 * Каркас пакета: здесь живут только базовые типы конверта JSON-RPC 2.0.
 * Методы (`session.create`, `turn.start`, …), события и их полезная нагрузка
 * добавляются задачей #004 — `DshBridge: JSON-RPC stdio и supervisor`.
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

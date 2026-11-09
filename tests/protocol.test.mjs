import assert from 'node:assert/strict';
import test from 'node:test';

import {
  JSONRPC_VERSION,
  PROTOCOL_VERSION,
  isJsonRpcResponse
} from '../protocol/dist/index.js';

test('protocol: пакет собирается и импортируется', () => {
  assert.equal(PROTOCOL_VERSION, '0.1.0');
  assert.equal(JSONRPC_VERSION, '2.0');
});

test('protocol: конверт JSON-RPC 2.0 различает ответ и запрос', () => {
  assert.equal(isJsonRpcResponse({ jsonrpc: '2.0', id: 1, result: { ok: true } }), true);
  assert.equal(
    isJsonRpcResponse({ jsonrpc: '2.0', id: 2, error: { code: -32601, message: 'not found' } }),
    true
  );
  assert.equal(isJsonRpcResponse({ jsonrpc: '2.0', id: 3, method: 'workspace.ping' }), false);
});

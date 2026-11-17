import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  DSH_EVENTS,
  DSH_METHODS,
  isDshEvent,
  isDshMethod,
  WORKSPACE_PING_METHOD
} from '../protocol/dist/index.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('protocol: методы из §5.2 спецификации', () => {
  assert.deepEqual([...DSH_METHODS].sort(), [
    'approval.resolve',
    'context.reload',
    'diagnostics.report',
    'session.create',
    'session.list',
    'session.resume',
    'tools.invoke',
    'turn.cancel',
    'turn.start',
    'workspace.ping'
  ]);
  assert.equal(WORKSPACE_PING_METHOD, 'workspace.ping');
});

test('protocol: события из §5.2 спецификации', () => {
  assert.deepEqual([...DSH_EVENTS].sort(), [
    'approval.request',
    'error',
    'status',
    'token',
    'tool.call',
    'tool.result',
    'turn.done'
  ]);
});

test('protocol: рантайм-проверки имён методов и событий', () => {
  assert.equal(isDshMethod('turn.start'), true);
  assert.equal(isDshMethod('turn.nope'), false);
  assert.equal(isDshEvent('token'), true);
  assert.equal(isDshEvent('session.create'), false, 'метод — не событие');
});

test('extension не дублирует имена методов DSH', async () => {
  const source = await readFile(
    path.join(repoRoot, 'extension', 'src', 'bridge', 'dshBridge.ts'),
    'utf8'
  );

  for (const method of DSH_METHODS) {
    assert.ok(
      !source.includes(`'${method}'`) && !source.includes(`"${method}"`),
      `имя метода ${method} должно приходить из protocol/, а не дублироваться в extension`
    );
  }
});

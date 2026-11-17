import assert from 'node:assert/strict';
import test from 'node:test';

import {
  collectDiagnostics,
  diagnosticsPayload
} from '../extension/src/diagnostics/collector.ts';

function diag(file, message, severity = 'error') {
  return { file, message, severity, line: 1 };
}

test('collectDiagnostics: лимит по количеству', () => {
  const files = ['a.ts'];
  const report = collectDiagnostics(files, () => [diag('a.ts', '1'), diag('a.ts', '2'), diag('a.ts', '3')], {
    maxItems: 2
  });
  assert.equal(report.items.length, 2);
  assert.equal(report.total, 3);
  assert.equal(report.truncated, true);
});

test('collectDiagnostics: лимит по размеру и payload', () => {
  const report = collectDiagnostics(
    ['a.ts'],
    () => [diag('a.ts', 'x'.repeat(100)), diag('a.ts', 'ok')],
    { maxBytes: 5 }
  );
  assert.equal(report.items.length, 0);
  assert.equal(report.truncated, true);
  const payload = diagnosticsPayload(report);
  assert.equal(payload.count, 2);
  assert.equal(payload.truncated, true);
  assert.deepEqual(payload.items, []);
});

test('collectDiagnostics: несколько файлов и severity/source/line', () => {
  const map = {
    'a.ts': [diag('a.ts', 'ошибка', 'error')],
    'b.ts': [{ ...diag('b.ts', 'варнинг', 'warning'), source: 'ts' }]
  };
  const report = collectDiagnostics(['a.ts', 'b.ts'], (file) => map[file] ?? []);
  assert.equal(report.items.length, 2);
  assert.equal(report.total, 2);
  assert.equal(report.truncated, false);
  const payload = diagnosticsPayload(report);
  assert.equal(payload.items[0].severity, 'error');
  assert.equal(payload.items[1].source, 'ts');
  assert.equal(payload.items[1].line, 1);
});

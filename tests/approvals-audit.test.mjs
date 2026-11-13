import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

import { AuditLog, sanitizeForAudit } from '../extension/src/approvals/auditLog.ts';

const tmpRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), 'dsh-approvals-audit-')));
after(() => rm(tmpRoot, { recursive: true, force: true }));

let counter = 0;
function filePath(name) {
  counter += 1;
  return path.join(tmpRoot, `${String(counter)}-${name}`, 'audit.log');
}

function entry(overrides = {}) {
  return {
    timestamp: '2026-11-09T12:00:00.000Z',
    sessionId: 'sess_1',
    tool: 'write_file',
    kind: 'write',
    decision: 'deny',
    source: 'user',
    ...overrides
  };
}

async function readLines(filePathToRead) {
  const text = await readFile(filePathToRead, 'utf8');
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line));
}

test('аудит: JSONL-записи дописываются и читаются', async () => {
  const log = new AuditLog({ filePath: filePath('basic') });

  await log.record(entry({ decision: 'allow', source: 'policy', reason: null }));
  await log.record(entry({ decision: 'deny', source: 'user', reason: 'пользователь отказал' }));

  const records = await readLines(log.filePath);
  assert.equal(records.length, 2);
  assert.equal(records[0].tool, 'write_file');
  assert.equal(records[0].decision, 'allow');
  assert.equal(records[1].decision, 'deny');
  assert.equal(records[1].reason, 'пользователь отказал');
});

test('аудит: секреты не попадают в журнал', async () => {
  const log = new AuditLog({ filePath: filePath('secrets') });

  await log.record(
    entry({
      arguments: {
        token: 'top-secret-token',
        apiKey: 'sk-secret',
        nested: { password: 'pass-123', ok: 'visible' },
        url: 'https://user:secret@example.com/repo'
      }
    })
  );

  const text = await readFile(log.filePath, 'utf8');
  assert.ok(!text.includes('top-secret-token'));
  assert.ok(!text.includes('sk-secret'));
  assert.ok(!text.includes('pass-123'));
  assert.ok(!text.includes('user:secret'));
  assert.ok(text.includes('visible'));
  assert.ok(text.includes('https://example.com/repo'));

  const [record] = await readLines(log.filePath);
  assert.equal(record.arguments.token, undefined);
  assert.equal(record.arguments.nested.ok, 'visible');
});

test('аудит: ротация по размеру и ограничение числа архивов', async () => {
  const log = new AuditLog({ filePath: filePath('rotate'), maxBytes: 260, maxFiles: 2 });

  for (let index = 0; index < 6; index += 1) {
    await log.record(entry({ reason: `решение номер ${index}` }));
  }

  const current = await readLines(log.filePath);
  assert.ok(current.length >= 1);
  assert.ok(current.length <= 3, `в текущем журнале ${String(current.length)} записей`);

  const archive = await readLines(`${log.filePath}.1`);
  assert.ok(archive.length >= 1, 'архив создан');

  // Старше maxFiles архивы не храним (rotate → .1/.2, дальше теряем).
  await assert.rejects(() => readFile(`${log.filePath}.3`, 'utf8'));
});

test('аудит: query-токены и секреты в reason/targetPath не пишутся', async () => {
  const log = new AuditLog({ filePath: filePath('query-secrets') });

  await log.record(
    entry({
      targetPath: 'src/app.ts?token=SECRET-PATH',
      reason: 'не удалось открыть https://example.com/x?token=SECRET-REASON',
      arguments: { url: 'https://example.com/path?access_token=SECRET-ARG' }
    })
  );

  const text = await readFile(log.filePath, 'utf8');
  assert.ok(!text.includes('SECRET-PATH'));
  assert.ok(!text.includes('SECRET-REASON'));
  assert.ok(!text.includes('SECRET-ARG'));

  const [record] = await readLines(log.filePath);
  assert.equal(record.targetPath, 'src/app.ts');
  assert.equal(record.reason, 'не удалось открыть https://example.com/x');
  assert.equal(record.arguments.url, 'https://example.com/path');
});

test('sanitizeForAudit: вырезает секретные ключи и креденшелы рекурсивно', () => {
  const sanitized = sanitizeForAudit({
    authorization: 'Bearer x',
    clientSecret: 'x',
    deep: { a: { b: { token: 'y', keep: 1 } } },
    link: 'ssh://git@host/x'
  });

  // userinfo (логин и пароль) из URL вычищается целиком.
  assert.deepEqual(sanitized, {
    deep: { a: { b: { keep: 1 } } },
    link: 'ssh://host/x'
  });
});

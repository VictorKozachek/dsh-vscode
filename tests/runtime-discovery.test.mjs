import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import {
  discoverRuntime,
  redactSecrets,
  RUNTIME_INSTALL_INSTRUCTIONS
} from '../extension/src/runtime/discovery.ts';

const HOME = '/Users/victor';

test('явный dsh.executablePath имеет приоритет', async () => {
  const result = await discoverRuntime({
    executablePath: '/opt/dsh/bin/dsh',
    homeDirectory: HOME,
    isFile: async (filePath) => filePath === '/opt/dsh/bin/dsh',
    which: async () => '/usr/local/bin/dsh'
  });

  assert.equal(result.status, 'found');
  assert.equal(result.command.command, '/opt/dsh/bin/dsh');
  assert.equal(result.command.source, 'setting');
  assert.deepEqual(result.command.args, ['--profile', 'acp']);
});

test('несуществующий dsh.executablePath — ошибка без fallback на другие бинари', async () => {
  const result = await discoverRuntime({
    executablePath: '/missing/dsh',
    homeDirectory: HOME,
    isFile: async () => false,
    which: async () => '/usr/local/bin/dsh'
  });

  assert.equal(result.status, 'missing');
  assert.match(result.instructions, /\/missing\/dsh/);
  assert.ok(result.attempts.some((line) => line.includes('/missing/dsh')));
});

test('dsh из PATH', async () => {
  const result = await discoverRuntime({
    homeDirectory: HOME,
    isFile: async () => false,
    which: async (name) => (name === 'dsh' ? '/usr/local/bin/dsh' : null)
  });

  assert.equal(result.status, 'found');
  assert.equal(result.command.source, 'path');
  assert.equal(result.command.displayPath, '/usr/local/bin/dsh');
});

test('бинарь из профиля ~/.dsh/profiles/<profile>/node_modules/.bin/dsh', async () => {
  const expected = path.join(HOME, '.dsh', 'profiles', 'acp', 'node_modules', '.bin', 'dsh');
  const result = await discoverRuntime({
    homeDirectory: HOME,
    isFile: async (filePath) => filePath === expected,
    which: async () => null
  });

  assert.equal(result.status, 'found');
  assert.equal(result.command.source, 'profile');
  assert.equal(result.command.command, expected);
});

test('последний резерв — npx, его можно отключить', async () => {
  const fallback = await discoverRuntime({
    homeDirectory: HOME,
    isFile: async () => false,
    which: async () => null
  });
  assert.equal(fallback.status, 'found');
  assert.equal(fallback.command.source, 'npx');
  assert.deepEqual(fallback.command.args.slice(0, 2), ['--yes', '@deepseek-ai/dsh']);

  const disabled = await discoverRuntime({
    homeDirectory: HOME,
    isFile: async () => false,
    which: async () => null,
    allowNpxFallback: false
  });
  assert.equal(disabled.status, 'missing');
  assert.equal(disabled.instructions, RUNTIME_INSTALL_INSTRUCTIONS);
});

test('redactSecrets: токены и креденшелы не попадают в лог', () => {
  assert.equal(
    redactSecrets('dsh web: http://127.0.0.1:3080/?token=SECRET123&x=1'),
    'dsh web: http://127.0.0.1:3080/?token=[redacted]&x=1'
  );
  assert.equal(
    redactSecrets('Authorization: Bearer abc.def-123'),
    'Authorization: Bearer [redacted]'
  );
  assert.equal(
    redactSecrets('https://user:pass@example.com/repo?api_key=SECRET'),
    'https://example.com/repo?api_key=[redacted]'
  );
});

test('голое имя в dsh.executablePath ищется через PATH (дефолт «dsh»)', async () => {
  const result = await discoverRuntime({
    executablePath: 'dsh',
    homeDirectory: HOME,
    isFile: async () => false,
    which: async (name) => (name === 'dsh' ? '/usr/local/bin/dsh' : null)
  });
  assert.equal(result.status, 'found');
  assert.equal(result.command.source, 'setting');
  assert.equal(result.command.command, '/usr/local/bin/dsh');

  const missing = await discoverRuntime({
    executablePath: 'dsh',
    homeDirectory: HOME,
    isFile: async () => false,
    which: async () => null
  });
  assert.equal(missing.status, 'missing');
});

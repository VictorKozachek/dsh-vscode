import assert from 'node:assert/strict';
import test from 'node:test';

import {
  evaluateApproval,
  isPathInsideWorkspace,
  parseSandboxMode,
  sandboxAllowsWrites,
  toDshSandboxArguments
} from '../extension/src/approvals/approvalPolicy.ts';

const ROOT = '/Users/victor/projects/api-service';

function request(overrides = {}) {
  return { id: 'req_1', tool: 'write_file', kind: 'write', sessionId: 'sess_1', ...overrides };
}

function context(overrides = {}) {
  return {
    workspaceRoot: ROOT,
    sandboxMode: 'workspace-write',
    policy: 'ask',
    ...overrides
  };
}

test('sandbox: нормализация, флаги dsh и запрет записи в read-only', () => {
  assert.equal(parseSandboxMode('read-only'), 'read-only');
  assert.equal(parseSandboxMode('unknown'), 'workspace-write');
  assert.equal(parseSandboxMode(undefined), 'workspace-write');
  assert.deepEqual(toDshSandboxArguments('danger-full-access'), [
    '--sandbox',
    'danger-full-access'
  ]);
  assert.equal(sandboxAllowsWrites('read-only'), false);
  assert.equal(sandboxAllowsWrites('workspace-write'), true);
});

test('пути: внутри воркспейса, снаружи и относительные', () => {
  assert.equal(isPathInsideWorkspace('src/app.ts', ROOT), true);
  assert.equal(isPathInsideWorkspace(`${ROOT}/src/app.ts`, ROOT), true);
  assert.equal(isPathInsideWorkspace('/etc/passwd', ROOT), false);
  assert.equal(isPathInsideWorkspace('../other/app.ts', ROOT), false);
  assert.equal(isPathInsideWorkspace('/Users/victor/projects/api-service-two/x', ROOT), false);
  assert.equal(isPathInsideWorkspace(ROOT, ROOT), true);
});

test('auto: запись внутри разрешена, вне воркспейса и сеть — спрашиваем', () => {
  const ctx = context({ policy: 'auto' });

  assert.deepEqual(evaluateApproval(request({ targetPath: 'src/app.ts' }), ctx), {
    action: 'allow',
    reason: null
  });
  assert.equal(evaluateApproval(request({ targetPath: '/etc/passwd' }), ctx).action, 'ask');
  assert.match(evaluateApproval(request({ targetPath: '/etc/passwd' }), ctx).reason, /вне воркспейса/);
  assert.equal(evaluateApproval(request({ kind: 'network', tool: 'http_get' }), ctx).action, 'ask');
  assert.match(evaluateApproval(request({ kind: 'network' }), ctx).reason, /сетевой вызов/);
  assert.equal(evaluateApproval(request({ kind: 'read', tool: 'read_file' }), ctx).action, 'allow');
});

test('ask: запись и команды спрашивают, чтение разрешено', () => {
  const ctx = context({ policy: 'ask' });

  assert.equal(evaluateApproval(request({ targetPath: 'a.ts' }), ctx).action, 'ask');
  assert.equal(evaluateApproval(request({ kind: 'execute', tool: 'run' }), ctx).action, 'ask');
  assert.equal(evaluateApproval(request({ kind: 'read', tool: 'read_file' }), ctx).action, 'allow');
});

test('never: подтверждаемые операции запрещаются, чтение разрешено', () => {
  const ctx = context({ policy: 'never' });

  assert.equal(evaluateApproval(request({ targetPath: 'a.ts' }), ctx).action, 'deny');
  assert.match(evaluateApproval(request({ targetPath: 'a.ts' }), ctx).reason, /never/);
  assert.equal(evaluateApproval(request({ kind: 'network' }), ctx).action, 'deny');
  assert.equal(evaluateApproval(request({ kind: 'read' }), ctx).action, 'allow');
});

test('sandbox read-only запрещает запись и запуск команд', () => {
  const ctx = context({ sandboxMode: 'read-only', policy: 'auto' });

  assert.equal(evaluateApproval(request({ targetPath: 'a.ts' }), ctx).action, 'deny');
  assert.match(evaluateApproval(request({ targetPath: 'a.ts' }), ctx).reason, /read-only/);
  assert.equal(evaluateApproval(request({ kind: 'execute' }), ctx).action, 'deny');
  assert.equal(evaluateApproval(request({ kind: 'read' }), ctx).action, 'allow');
});

test('политика per-tool переопределяет общую', () => {
  const ctx = context({ policy: 'auto', toolPolicies: { write_file: 'ask' } });

  assert.equal(evaluateApproval(request({ targetPath: 'a.ts' }), ctx).action, 'ask');
  assert.equal(
    evaluateApproval(request({ tool: 'other_tool', targetPath: 'a.ts' }), ctx).action,
    'allow'
  );
});

test('запись вне воркспейса требует подтверждения даже при auto и запрещена при never', () => {
  const auto = evaluateApproval(request({ targetPath: '/tmp/outside.ts' }), context({ policy: 'auto' }));
  assert.equal(auto.action, 'ask');

  const never = evaluateApproval(request({ targetPath: '/tmp/outside.ts' }), context({ policy: 'never' }));
  assert.equal(never.action, 'deny');
});

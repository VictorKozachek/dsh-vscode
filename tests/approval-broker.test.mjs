import assert from 'node:assert/strict';
import test from 'node:test';

import { ApprovalBroker } from '../extension/src/approvals/approvalBroker.ts';
import { evaluateApproval } from '../extension/src/approvals/approvalPolicy.ts';
import { createFallbackApprovalUi } from '../extension/src/approvals/fallback.ts';

const ROOT = '/Users/victor/projects/api-service';
/** Даёт брокеру дойти до регистрации pending (оценка политики/аудит — async). */
const tick = () => new Promise((resolve) => setImmediate(resolve));
const NOW = '2026-11-09T12:00:00.000Z';

function writeRequest(overrides = {}) {
  return {
    id: 'req_1',
    tool: 'write_file',
    kind: 'write',
    targetPath: 'src/app.ts',
    sessionId: 'sess_1',
    ...overrides
  };
}

function makeBroker({
  policy = 'ask',
  sandboxMode = 'workspace-write',
  ui,
  toolPolicies,
  audit,
  resolveRealPath,
  onResolved,
  logger
} = {}) {
  const audits = [];
  const broker = new ApprovalBroker({
    context: { workspaceRoot: ROOT, sandboxMode, policy, toolPolicies },
    evaluate: evaluateApproval,
    ui: ui ?? { ask: () => undefined },
    audit: audit ?? {
      record: (entry) => {
        audits.push(entry);
      }
    },
    clock: () => new Date(NOW),
    // По умолчанию «путь уже реальный»: тесты политики не про symlink.
    resolveRealPath: resolveRealPath ?? (async (absolutePath) => absolutePath),
    onResolved,
    logger
  });
  return { broker, audits };
}

test('политика allow не спрашивает пользователя', async () => {
  let asked = 0;
  const { broker, audits } = makeBroker({
    policy: 'auto',
    ui: { ask: () => {
      asked += 1;
      return Promise.resolve('deny');
    } }
  });

  const decision = await broker.request(writeRequest());

  assert.equal(decision, 'allow');
  assert.equal(asked, 0);
  assert.equal(audits.length, 1);
  assert.equal(audits[0].decision, 'allow');
  assert.equal(audits[0].source, 'policy');
  broker.dispose();
});

test('«Отклонить» гарантированно останавливает инструмент', async () => {
  let executed = false;
  const { broker, audits } = makeBroker({
    policy: 'ask',
    ui: { ask: () => Promise.resolve('deny') }
  });

  const decision = await broker.request(writeRequest());
  if (decision !== 'deny') {
    executed = true;
  }

  assert.equal(decision, 'deny');
  assert.equal(executed, false, 'инструмент не должен выполняться');
  assert.equal(audits.at(-1).decision, 'deny');
  assert.equal(audits.at(-1).source, 'user');
  broker.dispose();
});

test('«Разрешить для этой сессии» запоминается для инструмента', async () => {
  let asked = 0;
  const { broker } = makeBroker({
    policy: 'ask',
    ui: {
      ask: () => {
        asked += 1;
        return Promise.resolve('allow-session');
      }
    }
  });

  assert.equal(await broker.request(writeRequest()), 'allow-session');
  assert.equal(broker.isSessionAllowed('sess_1', 'write_file'), true);

  assert.equal(await broker.request(writeRequest({ id: 'req_2' })), 'allow');
  assert.equal(asked, 1, 'повторный запрос не спрашивает (сессия уже разрешила)');
  assert.equal(broker.isSessionAllowed('sess_2', 'write_file'), false);
  broker.dispose();
});

test('«разрешить для сессии» не обходит обязательные подтверждения и запреты', async () => {
  const answers = ['allow-session', 'deny'];
  let asked = 0;
  const { broker } = makeBroker({
    policy: 'ask',
    ui: {
      ask: () => {
        asked += 1;
        return Promise.resolve(answers[asked - 1] ?? 'deny');
      }
    }
  });

  assert.equal(await broker.request(writeRequest({ id: 'r1' })), 'allow-session');
  assert.equal(broker.isSessionAllowed('sess_1', 'write_file'), true);

  // Запись вне воркспейса спрашивается заново, несмотря на сессионное разрешение.
  assert.equal(await broker.request(writeRequest({ id: 'r2', targetPath: '/tmp/evil.ts' })), 'deny');
  assert.equal(asked, 2, 'обязательное подтверждение спросили заново');

  broker.dispose();
});

test('внешнее решение из WebView закрывает pending', async () => {
  const { broker, audits } = makeBroker({ policy: 'ask', ui: { ask: () => undefined } });

  const pending = broker.request(writeRequest({ id: 'req_web' }));
  await tick();
  assert.equal(broker.pending.length, 1);
  assert.equal(broker.pending[0].id, 'req_web');

  assert.equal(broker.resolve('req_web', 'deny'), true);
  assert.equal(await pending, 'deny');
  assert.equal(broker.pending.length, 0);
  assert.equal(audits.at(-1).decision, 'deny');
  assert.equal(broker.resolve('req_web', 'allow'), false, 'повторное решение отклоняется');
  broker.dispose();
});

test('dispose закрывает pending как отклонённые', async () => {
  const { broker, audits } = makeBroker({ policy: 'ask', ui: { ask: () => undefined } });

  const pending = broker.request(writeRequest({ id: 'req_dispose' }));
  await tick();
  broker.dispose();

  assert.equal(await pending, 'deny');
  assert.equal(broker.pending.length, 0);
  assert.equal(audits.at(-1).source, 'dispose');
});

test('ошибка UI подтверждения трактуется как отказ и пишется в аудит', async () => {
  const { broker, audits } = makeBroker({
    policy: 'ask',
    ui: { ask: () => Promise.reject(new Error('panel closed')) }
  });

  assert.equal(await broker.request(writeRequest()), 'deny');
  assert.equal(audits.at(-1).decision, 'deny');
  broker.dispose();
});

test('«Показать diff» отдаёт запрос в UI', async () => {
  const shown = [];
  const { broker } = makeBroker({
    policy: 'ask',
    ui: {
      ask: () => undefined,
      showDiff: (request) => {
        shown.push(request);
      }
    }
  });

  const pending = broker.request(writeRequest({ id: 'req_diff' }));
  await tick();
  assert.equal(broker.showDiff('req_diff'), true);
  assert.equal(shown[0]?.id, 'req_diff');
  assert.equal(broker.showDiff('missing'), false);

  broker.resolve('req_diff', 'allow');
  await pending;
  broker.dispose();
});

test('fallback-уведомление даёт те же три решения и не блокирует', async () => {
  const calls = [];
  const window = {
    async showInformationMessage(message, ...items) {
      calls.push({ message, items });
      return items[0];
    }
  };
  const ui = createFallbackApprovalUi(window);
  const broker = new ApprovalBroker({
    context: { workspaceRoot: ROOT, sandboxMode: 'workspace-write', policy: 'ask' },
    evaluate: evaluateApproval,
    ui
  });

  const decision = await broker.request(writeRequest({ targetPath: 'src/a.ts' }));
  assert.equal(decision, 'allow');
  assert.match(calls[0].message, /write_file/);
  assert.deepEqual(calls[0].items, [
    'Разрешить',
    'Разрешить для этой сессии',
    'Отклонить'
  ]);
  broker.dispose();

  const closed = createFallbackApprovalUi({
    async showInformationMessage() {
      return undefined;
    }
  });
  const closedBroker = new ApprovalBroker({
    context: { workspaceRoot: ROOT, sandboxMode: 'workspace-write', policy: 'ask' },
    evaluate: evaluateApproval,
    ui: closed
  });
  assert.equal(await closedBroker.request(writeRequest()), 'deny', 'закрытие уведомления = отказ');
  closedBroker.dispose();
});

test('symlink наружу: resolveRealPath превращает путь вне root в обязательное подтверждение', async () => {
  const { broker } = makeBroker({
    policy: 'auto',
    ui: { ask: () => Promise.resolve('deny') },
    resolveRealPath: async (absolutePath) =>
      absolutePath.endsWith('/link/evil.ts') ? '/outside/evil.ts' : absolutePath
  });

  const decision = await broker.request(
    writeRequest({ id: 'req_link', targetPath: 'link/evil.ts' })
  );

  assert.equal(decision, 'deny', 'вне root после realpath — обязательный ask');
  broker.dispose();
});

test('onResolved уведомляет о решении вне WebView (fallback и dispose)', async () => {
  const resolved = [];
  const { broker } = makeBroker({
    policy: 'ask',
    ui: { ask: () => Promise.resolve('allow') },
    onResolved: (request, decision) => {
      resolved.push({ id: request.id, decision });
    }
  });
  await broker.request(writeRequest({ id: 'r1' }));
  assert.deepEqual(resolved, [{ id: 'r1', decision: 'allow' }]);
  broker.dispose();

  const resolved2 = [];
  const second = makeBroker({
    policy: 'ask',
    ui: { ask: () => undefined },
    onResolved: (request, decision) => {
      resolved2.push({ id: request.id, decision });
    }
  });
  const pending = second.broker.request(writeRequest({ id: 'r2' }));
  await tick();
  second.broker.dispose();
  await pending;
  assert.deepEqual(resolved2, [{ id: 'r2', decision: 'deny' }]);
});

test('сессионное разрешение аудируется как source=session', async () => {
  const { broker, audits } = makeBroker({
    policy: 'ask',
    ui: { ask: () => Promise.resolve('allow-session') }
  });

  await broker.request(writeRequest({ id: 'a' }));
  await broker.request(writeRequest({ id: 'b' }));

  assert.equal(audits[0].source, 'user');
  assert.equal(audits[0].decision, 'allow-session');
  assert.equal(audits[1].source, 'session');
  assert.equal(audits[1].decision, 'allow');
  broker.dispose();
});

test('ошибка записи аудита не ломает решение и логируется', async () => {
  const logs = [];
  const { broker } = makeBroker({
    policy: 'auto',
    audit: { record: () => Promise.reject(new Error('disk full')) },
    logger: (line) => logs.push(line)
  });

  assert.equal(await broker.request(writeRequest({ id: 'a' })), 'allow');
  await tick();
  assert.ok(logs.some((line) => line.includes('аудит')));
  broker.dispose();
});

test('symlink-граница: новый файл под symlink наружу — обязательное подтверждение', async () => {
  const { broker } = makeBroker({
    policy: 'auto',
    ui: { ask: () => Promise.resolve('deny') },
    resolveRealPath: async (absolutePath) => {
      // Реального файла ещё нет; ближайший существующий предок link → outside.
      if (absolutePath.endsWith('/link/new.ts')) {
        return null;
      }
      if (absolutePath.endsWith('/link')) {
        return '/outside';
      }
      return absolutePath;
    }
  });

  const decision = await broker.request(
    writeRequest({ id: 'req_link_new', targetPath: 'link/new.ts' })
  );
  assert.equal(decision, 'deny', 'после realpath путь вне root — обязательный ask');
  broker.dispose();
});

test('fail-closed: без резолвера, при null и при ошибке запись не авто-разрешается', async () => {
  for (const [name, resolveRealPath] of [
    ['нет резолвера', undefined],
    ['null', async () => null],
    ['ошибка', async () => Promise.reject(new Error('EACCES'))]
  ]) {
    const { broker } = makeBroker({
      policy: 'auto',
      ui: { ask: () => Promise.resolve('deny') },
      resolveRealPath
    });
    const decision = await broker.request(
      writeRequest({ id: `req_${name}`, targetPath: '/repo/src/app.ts' })
    );
    assert.equal(decision, 'deny', `${name}: должен быть спрошен пользователь`);
    broker.dispose();
  }
});

test('resolved-путь внутри root при auto разрешается как раньше', async () => {
  const { broker } = makeBroker({
    policy: 'auto',
    resolveRealPath: async (absolutePath) => absolutePath
  });
  assert.equal(
    await broker.request(writeRequest({ id: 'req_inside', targetPath: `${ROOT}/src/a.ts` })),
    'allow'
  );
  broker.dispose();
});

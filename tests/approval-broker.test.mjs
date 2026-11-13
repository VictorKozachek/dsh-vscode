import assert from 'node:assert/strict';
import test from 'node:test';

import { ApprovalBroker } from '../extension/src/approvals/approvalBroker.ts';
import { evaluateApproval } from '../extension/src/approvals/approvalPolicy.ts';
import { createFallbackApprovalUi } from '../extension/src/approvals/fallback.ts';

const ROOT = '/Users/victor/projects/api-service';
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

function makeBroker({ policy = 'ask', sandboxMode = 'workspace-write', ui, toolPolicies } = {}) {
  const audits = [];
  const broker = new ApprovalBroker({
    context: { workspaceRoot: ROOT, sandboxMode, policy, toolPolicies },
    evaluate: evaluateApproval,
    ui: ui ?? { ask: () => undefined },
    audit: {
      record: (entry) => {
        audits.push(entry);
      }
    },
    clock: () => new Date(NOW)
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

test('внешнее решение из WebView закрывает pending', async () => {
  const { broker, audits } = makeBroker({ policy: 'ask', ui: { ask: () => undefined } });

  const pending = broker.request(writeRequest({ id: 'req_web' }));
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

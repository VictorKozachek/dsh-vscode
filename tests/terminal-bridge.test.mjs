import assert from 'node:assert/strict';
import test from 'node:test';

import {
  OutputBuffer,
  TerminalBridge
} from '../extension/src/terminal/terminalBridge.ts';

function execution(chunks, exitCode = 0) {
  return {
    async *read() {
      for (const chunk of chunks) {
        yield chunk;
      }
    },
    exitCode: Promise.resolve(exitCode)
  };
}

function harness({ approval = 'allow', shell = true, execution: exec } = {}) {
  const calls = { approve: 0, execute: [], dispose: 0, created: 0 };
  const bridge = new TerminalBridge({
    timeoutMs: 100,
    maxOutputBytes: 16,
    approval: {
      async request(input) {
        calls.approve += 1;
        calls.lastApproval = input;
        return approval;
      }
    },
    createSession: async (input) => {
      calls.created += 1;
      calls.createdWith = input;
      return {
        shellIntegrationAvailable: shell,
        execute(command) {
          calls.execute.push(command);
          return exec ?? execution(['stdout ', 'line\n'], 0);
        },
        dispose() {
          calls.dispose += 1;
        }
      };
    }
  });
  return { bridge, calls };
}

test('approval deny: команда не выполняется', async () => {
  const { bridge, calls } = harness({ approval: 'deny' });
  const result = await bridge.run({ sessionId: 's', command: 'rm -rf /tmp/x' });
  assert.equal(result.status, 'denied');
  assert.equal(calls.execute.length, 0);
  assert.equal(calls.created, 0, 'терминал не создаётся до approval');
  assert.equal(calls.approve, 1);
  assert.equal(calls.lastApproval.command, 'rm -rf /tmp/x');
});

test('allow: вывод и код возврата', async () => {
  const { bridge, calls } = harness({ approval: 'allow', execution: execution(['a', 'b'], 7) });
  const result = await bridge.run({ sessionId: 's', command: 'echo ok' });
  assert.equal(result.status, 'ok');
  assert.equal(result.output, 'ab');
  assert.equal(result.exitCode, 7);
  assert.equal(calls.dispose, 1);
});

test('лимит буфера обрезает вывод и помечает truncated', async () => {
  const buffer = new OutputBuffer(4);
  buffer.append('abcdef');
  assert.equal(buffer.text, 'abcd');
  assert.equal(buffer.truncated, true);
  buffer.append('ещё');
  assert.equal(buffer.text, 'abcd');

  const { bridge } = harness({ execution: execution(['0123456789abcdef'.repeat(4)], 0) });
  const result = await bridge.run({ sessionId: 's', command: 'long' });
  assert.equal(result.truncated, true);
  assert.ok(Buffer.byteLength(result.output, 'utf8') <= 16);
});

test('таймаут команды', async () => {
  const never = {
    async *read() {
      await new Promise(() => {});
      yield '';
    },
    exitCode: new Promise(() => {})
  };
  const { bridge } = harness({ execution: never });
  const result = await bridge.run({ sessionId: 's', command: 'sleep 100' });
  assert.equal(result.status, 'timeout');
  assert.match(result.error ?? '', /таймаут/);
});

test('отмена команды и отсутствие shell integration', async () => {
  const never = {
    async *read() {
      await new Promise(() => {});
      yield '';
    },
    exitCode: new Promise(() => {})
  };
  const { bridge } = harness({ execution: never });
  const running = bridge.run({ sessionId: 's', command: 'sleep 100' });
  await new Promise((resolve) => setTimeout(resolve, 10));
  bridge.cancel();
  const cancelled = await running;
  assert.equal(cancelled.status, 'error');
  assert.match(cancelled.error ?? '', /отменена/);

  const { bridge: noShell, calls } = harness({ shell: false });
  const result = await noShell.run({ sessionId: 's', command: 'echo' });
  assert.equal(result.status, 'no-shell-integration');
  assert.equal(calls.execute.length, 0);
});

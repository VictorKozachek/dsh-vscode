import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { register } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

register('./helpers/ts-loader.mjs', import.meta.url);
const { AcpRuntime } = await import('../extension/src/runtime/acpRuntime.ts');
const { ChatController } = await import('../extension/src/views/chatEvents.ts');

const FIXTURE = path.resolve('tests/fixtures/fake-acp-runtime.mjs');
const tmpRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), 'dsh-acp-chat-')));
after(() => rm(tmpRoot, { recursive: true, force: true }));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(10);
  }
  throw new Error('не дождались условия');
}

test('ChatController получает токены ACP с правильным turnId (streaming, не отбрасывает)', async () => {
  const workspace = await mkdtemp(path.join(tmpRoot, 'ws-'));
  const runtime = new AcpRuntime({
    workspacePath: workspace,
    executablePath: FIXTURE,
    homeDirectory: path.join(tmpRoot, 'home'),
    logger: () => undefined,
    discovery: { allowNpxFallback: false }
  });
  await runtime.start();
  const created = await runtime.request('session.create', { workspaceId: 'ws' });

  const posts = [];
  const controller = new ChatController({
    bridge: runtime,
    getSessionId: () => created.sessionId,
    post: (message) => posts.push(message),
    sessions: {
      getSnapshot: () => ({ sessionId: created.sessionId, title: 't', status: 'active' }),
      getDraft: () => '',
      setDraft: () => undefined,
      on: () => ({ dispose() {} })
    }
  });

  await controller.send('привет');
  await waitFor(() => posts.some((message) => message.type === 'chatDone'));
  await sleep(20);

  const tokens = posts.filter((message) => message.type === 'chatToken');
  assert.ok(tokens.length > 0, 'токены не отброшены ChatController');
  assert.equal(tokens[0].turnId, 'turn-1');
  assert.equal(tokens.map((message) => message.text).join(''), 'Привет, мир!');
  assert.equal(posts.at(-1).type, 'chatStatus');
  assert.equal(posts.at(-1).status, 'idle');
  controller.dispose();
  await runtime.stop();
});

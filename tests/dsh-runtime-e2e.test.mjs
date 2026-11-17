/**
 * E2E с настоящим DSH-рантаймом (#021). Запускается только если задан
 * DSH_E2E_DSH_BIN (путь к lib/bin.js пакета @deepseek-ai/dsh):
 *
 *   DSH_E2E_DSH_BIN=/path/node_modules/@deepseek-ai/dsh/lib/bin.js \
 *   DSH_E2E_HOME=/tmp/dsh-e2e-home pnpm test
 *
 * По умолчанию тест пропускается: сеть/установка пакета не должны быть
 * обязательными для CI.
 */

import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { register } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

// acpRuntime.ts импортирует соседние модули без расширения — подставляем .ts.
register('./helpers/ts-loader.mjs', import.meta.url);

const BIN = process.env.DSH_E2E_DSH_BIN;
const HOME = process.env.DSH_E2E_HOME;
const skip = BIN === undefined || BIN === '' ? 'DSH_E2E_DSH_BIN не задан' : false;

const tmpRoot = skip === false ? await realpath(await mkdtemp(path.join(os.tmpdir(), 'dsh-e2e-'))) : undefined;
after(async () => {
  if (tmpRoot !== undefined) {
    await rm(tmpRoot, { recursive: true, force: true });
  }
});

test(
  'реальный DSH: старт, session.list, session.create, остановка',
  { skip },
  async () => {
    const { AcpRuntime } = await import('../extension/src/runtime/acpRuntime.ts');
    const workspace = await mkdtemp(path.join(tmpRoot, 'ws-'));
    const home = HOME ?? (await mkdtemp(path.join(tmpRoot, 'home-')));
    const runtime = new AcpRuntime({
      workspacePath: workspace,
      executablePath: BIN,
      profile: 'acp',
      homeDirectory: home,
      env: { ...process.env, DSH_HOME: home },
      logger: () => undefined,
      requestTimeoutMs: 60_000,
      shutdownGraceMs: 5_000,
      discovery: { allowNpxFallback: false }
    });

    try {
      await runtime.start();
      assert.equal(runtime.state, 'running', runtime.diagnostics.message);
      assert.ok(runtime.version.dsh, 'версия пакета dsh определена');

      const list = await runtime.request('session.list', { workspaceId: 'e2e' });
      assert.ok(Array.isArray(list.sessions));

      const created = await runtime.request('session.create', { workspaceId: 'e2e' });
      assert.match(created.sessionId, /[A-Za-z0-9-]+/);

      const resumed = await runtime.request('session.resume', { sessionId: created.sessionId });
      assert.equal(resumed.session.id, created.sessionId);
    } finally {
      await runtime.stop();
    }
    assert.equal(runtime.state, 'stopped');
  }
);

import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { detectKanbanPlugin } from '../extension/src/views/kanbanPlugin.ts';

async function fixture(content) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'dsh-kanban-plugin-'));
  const dir = path.join(home, '.dsh', 'profiles', 'acp');
  await mkdir(dir, { recursive: true });
  if (content !== undefined) {
    await writeFile(path.join(dir, 'package.json'), JSON.stringify(content));
  }
  return home;
}

test('dsh-kanban активен: зависимость в профиле', async () => {
  const home = await fixture({ dependencies: { '@deepseek-ai/dsh-kanban': '1.0.0' } });
  const status = await detectKanbanPlugin({ homeDirectory: home, profile: 'acp' });
  assert.equal(status.installed, true);
  assert.equal(status.profile, 'acp');
  assert.match(status.installCommand, /dsh plugin --profile acp add/);
});

test('dsh-kanban не установлен: нет зависимости/профиля', async () => {
  const home = await fixture({ dependencies: { '@deepseek-ai/dsh-acp-app': '1.0.0' } });
  const status = await detectKanbanPlugin({ homeDirectory: home, profile: 'acp' });
  assert.equal(status.installed, false);
  assert.match(status.reason ?? '', /нет dsh-kanban/);

  const empty = await mkdtemp(path.join(os.tmpdir(), 'dsh-kanban-empty-'));
  const missing = await detectKanbanPlugin({ homeDirectory: empty, profile: 'acp' });
  assert.equal(missing.installed, false);
  assert.match(missing.reason ?? '', /не установлен/);
});
